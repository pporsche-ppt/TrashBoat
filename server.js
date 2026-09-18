const express = require('express');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!DATABASE_URL) {
  console.warn('DATABASE_URL is not set. The server will not be able to start until a PostgreSQL connection string is configured.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' || (DATABASE_URL || '').includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : false
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const TAGS = ['Always ON', 'Disconnected', 'Normal ON', 'Normal OFF', 'Control'];
const SPECIAL_VALUES = ['CUT', 'CONNECT', 'IGNORE'];
const STATUSES = ['READY', 'ACTIVE', 'DEACTIVATED'];
const TYPES = ['CABLE', 'DEVICE'];

function validCode(code) {
  return typeof code === 'string' && /^\d{3}$/.test(code);
}

function isCable(code) {
  return validCode(code) && Number(code) >= 100 && Number(code) <= 299;
}

function isDevice(code) {
  return validCode(code) && Number(code) >= 300 && Number(code) <= 999;
}

function expectedTypeFromCode(code) {
  if (isCable(code)) return 'CABLE';
  if (isDevice(code)) return 'DEVICE';
  return null;
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.filter((tag) => TAGS.includes(tag)))];
}

function cleanText(value, max = 5000) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, max);
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Admin login required.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') throw new Error('bad role');
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired admin session.' });
  }
}

async function ensureDatabase() {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is missing.');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qr_records (
      code CHAR(3) PRIMARY KEY,
      type VARCHAR(10) NOT NULL CHECK (type IN ('CABLE', 'DEVICE')),
      status VARCHAR(14) NOT NULL DEFAULT 'READY' CHECK (status IN ('READY', 'ACTIVE', 'DEACTIVATED')),
      name TEXT NOT NULL DEFAULT '',
      description_tags TEXT[] NOT NULL DEFAULT '{}',
      operation_voltage TEXT NOT NULL DEFAULT '',
      details TEXT NOT NULL DEFAULT '',
      bypass_protection VARCHAR(7) NOT NULL DEFAULT 'IGNORE' CHECK (bypass_protection IN ('CUT', 'CONNECT', 'IGNORE')),
      emergency VARCHAR(7) NOT NULL DEFAULT 'IGNORE' CHECK (emergency IN ('CUT', 'CONNECT', 'IGNORE')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS device_pins (
      id BIGSERIAL PRIMARY KEY,
      device_code CHAR(3) NOT NULL REFERENCES qr_records(code) ON DELETE CASCADE,
      pin_name TEXT NOT NULL,
      pin_description TEXT NOT NULL DEFAULT '',
      UNIQUE(device_code, pin_name)
    );

    CREATE TABLE IF NOT EXISTS connections (
      id BIGSERIAL PRIMARY KEY,
      cable_code CHAR(3) NOT NULL REFERENCES qr_records(code) ON DELETE CASCADE,
      slot SMALLINT NOT NULL CHECK (slot IN (1,2)),
      endpoint_type VARCHAR(10) NOT NULL CHECK (endpoint_type IN ('TEXT','CABLE','DEVICE')),
      endpoint_code CHAR(3),
      endpoint_pin TEXT,
      descriptive_text TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(cable_code, slot)
    );

    CREATE TABLE IF NOT EXISTS link_operations (
      id UUID PRIMARY KEY,
      action VARCHAR(20) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      inserted_connection_ids BIGINT[] NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_connections_endpoint_code ON connections(endpoint_code);
    CREATE INDEX IF NOT EXISTS idx_qr_records_type_status ON qr_records(type,status);
  `);
}

async function getRecord(code) {
  const { rows } = await pool.query('SELECT * FROM qr_records WHERE code=$1', [code]);
  return rows[0] || null;
}

async function getConnections(code) {
  const { rows } = await pool.query(
    `SELECT id, cable_code, slot, endpoint_type, endpoint_code, endpoint_pin, descriptive_text
     FROM connections WHERE cable_code=$1 ORDER BY slot`, [code]
  );
  return rows;
}

async function getPins(code) {
  const { rows } = await pool.query(
    'SELECT id, pin_name, pin_description FROM device_pins WHERE device_code=$1 ORDER BY id', [code]
  );
  return rows;
}

async function getDeviceUsage(code) {
  const { rows } = await pool.query(
    `SELECT c.id, c.cable_code, c.slot, c.endpoint_pin, c.descriptive_text
     FROM connections c WHERE c.endpoint_type='DEVICE' AND c.endpoint_code=$1
     ORDER BY c.cable_code, c.slot`, [code]
  );
  return rows;
}

async function detailedRecord(code) {
  const record = await getRecord(code);
  if (!record) return null;
  const result = { ...record };
  if (record.type === 'CABLE') result.connections = await getConnections(code);
  else {
    result.pins = await getPins(code);
    result.connected_cables = await getDeviceUsage(code);
  }
  return result;
}

function validateQRPayload(body, recordType) {
  const type = recordType || body.type;
  if (!TYPES.includes(type)) throw new Error('Invalid QR type.');
  const tags = normalizeTags(body.descriptionTags);
  const bypassProtection = body.bypassProtection || 'IGNORE';
  const emergency = body.emergency || 'IGNORE';
  if (!SPECIAL_VALUES.includes(bypassProtection)) throw new Error('Invalid bypass protection value.');
  if (!SPECIAL_VALUES.includes(emergency)) throw new Error('Invalid emergency value.');
  return {
    name: cleanText(body.name, 200),
    description_tags: tags,
    operation_voltage: cleanText(body.operationVoltage, 100),
    details: cleanText(body.details, 10000),
    bypass_protection: bypassProtection,
    emergency
  };
}

async function saveCableConnections(client, code, connections) {
  if (!isCable(code)) throw new Error('Only cable QR codes have two connection slots.');
  if (!Array.isArray(connections)) throw new Error('Connections must be an array.');
  const normalized = [1,2].map((slot) => {
    const raw = connections.find((x) => Number(x.slot) === slot) || { slot };
    let endpointType = raw.endpointType || 'TEXT';
    if (!['TEXT','CABLE','DEVICE'].includes(endpointType)) endpointType = 'TEXT';
    const endpointCode = validCode(raw.endpointCode) ? raw.endpointCode : null;
    return {
      slot,
      endpointType,
      endpointCode,
      endpointPin: cleanText(raw.endpointPin, 200),
      descriptiveText: cleanText(raw.descriptiveText, 2000)
    };
  });

  for (const item of normalized) {
    if (item.endpointType === 'CABLE') {
      if (!item.endpointCode || !isCable(item.endpointCode)) throw new Error(`Connection ${item.slot} must point to a cable QR.`);
      if (item.endpointCode === code) throw new Error('A cable cannot connect to itself.');
      const target = await client.query('SELECT code, status, type FROM qr_records WHERE code=$1', [item.endpointCode]);
      if (!target.rows[0]) throw new Error(`Cable ${item.endpointCode} does not exist.`);
      if (target.rows[0].type !== 'CABLE') throw new Error('Cable connection must point to a cable.');
      if (target.rows[0].status === 'DEACTIVATED') throw new Error('Cannot connect to a deactivated QR code.');
      item.endpointPin = '';
    }

    if (item.endpointType === 'DEVICE') {
      if (!item.endpointCode || !isDevice(item.endpointCode)) throw new Error(`Connection ${item.slot} must point to a device QR.`);
      const target = await client.query('SELECT code, status, type FROM qr_records WHERE code=$1', [item.endpointCode]);
      if (!target.rows[0]) throw new Error(`Device ${item.endpointCode} does not exist.`);
      if (target.rows[0].type !== 'DEVICE') throw new Error('Device connection must point to a device.');
      if (target.rows[0].status === 'DEACTIVATED') throw new Error('Cannot connect to a deactivated QR code.');
      if (!item.endpointPin) throw new Error(`Connection ${item.slot} needs a device pin.`);
      const pin = await client.query('SELECT 1 FROM device_pins WHERE device_code=$1 AND pin_name=$2', [item.endpointCode, item.endpointPin]);
      if (!pin.rowCount) throw new Error(`Pin ${item.endpointPin} does not exist on device ${item.endpointCode}.`);
    }

    if (item.endpointType === 'TEXT') {
      item.endpointCode = null;
      item.endpointPin = '';
      if (!item.descriptiveText) throw new Error(`Connection ${item.slot} needs descriptive text.`);
    }

    await client.query(
      `INSERT INTO connections(cable_code,slot,endpoint_type,endpoint_code,endpoint_pin,descriptive_text,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT(cable_code,slot) DO UPDATE SET
         endpoint_type=EXCLUDED.endpoint_type,
         endpoint_code=EXCLUDED.endpoint_code,
         endpoint_pin=EXCLUDED.endpoint_pin,
         descriptive_text=EXCLUDED.descriptive_text,
         updated_at=NOW()`,
      [code, item.slot, item.endpointType, item.endpointCode, item.endpointPin, item.descriptiveText]
    );
  }
}

app.post('/api/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD is not configured on the server.' });
  const password = cleanText(req.body.password, 200);
  const a = Buffer.from(password);
  const b = Buffer.from(ADMIN_PASSWORD);
  const matches = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!matches) {
    return res.status(401).json({ error: 'Incorrect admin password.' });
  }
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, expiresIn: 43200 });
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/config', (req, res) => {
  res.json({ tags: TAGS, specialValues: SPECIAL_VALUES, statuses: STATUSES, types: TYPES });
});

app.get('/api/qr', async (req, res) => {
  try {
    const conditions = [];
    const values = [];
    if (req.query.type && TYPES.includes(req.query.type)) {
      values.push(req.query.type); conditions.push(`type=$${values.length}`);
    }
    if (req.query.status && STATUSES.includes(req.query.status)) {
      values.push(req.query.status); conditions.push(`status=$${values.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT code,type,status,name,description_tags,operation_voltage,updated_at
       FROM qr_records ${where} ORDER BY code`, values
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/qr/:code', async (req, res) => {
  try {
    if (!validCode(req.params.code)) return res.status(400).json({ error: 'QR code must be exactly 3 digits.' });
    const record = await detailedRecord(req.params.code);
    if (!record) return res.status(404).json({ error: 'QR code not found.' });
    res.json(record);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/qr/link', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const code = cleanText(req.body.code, 3);
    if (!validCode(code)) throw new Error('QR code must be exactly 3 digits.');
    const record = await getRecord(code);
    if (!record) throw new Error('QR code does not exist. Generate the QR code first.');
    if (record.status === 'DEACTIVATED') throw new Error('This QR code is permanently deactivated.');
    if (record.status !== 'READY') throw new Error('Only a READY QR code can be linked.');
    const type = record.type;
    const fields = validateQRPayload(req.body, type);

    await client.query('BEGIN');
    await client.query(
      `UPDATE qr_records SET status='ACTIVE', name=$2, description_tags=$3, operation_voltage=$4,
       details=$5, bypass_protection=$6, emergency=$7, updated_at=NOW() WHERE code=$1`,
      [code, fields.name, fields.description_tags, fields.operation_voltage, fields.details, fields.bypass_protection, fields.emergency]
    );
    if (type === 'DEVICE' && Array.isArray(req.body.pins)) {
      await savePins(client, code, req.body.pins);
    }
    if (type === 'CABLE') {
      await saveCableConnections(client, code, req.body.connections || []);
    }
    await client.query('COMMIT');
    res.json(await detailedRecord(code));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ error: error.message });
  } finally { client.release(); }
});

app.put('/api/qr/:code', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const code = cleanText(req.params.code, 3);
    if (!validCode(code)) throw new Error('QR code must be exactly 3 digits.');
    const record = await getRecord(code);
    if (!record) throw new Error('QR code not found.');
    if (record.status === 'DEACTIVATED') throw new Error('A deactivated QR code cannot be edited.');
    if (record.status === 'READY') return res.status(409).json({ redirect: 'link', error: 'READY QR codes must be linked instead of edited.' });
    const fields = validateQRPayload(req.body, record.type);
    await client.query('BEGIN');
    await client.query(
      `UPDATE qr_records SET name=$2, description_tags=$3, operation_voltage=$4,
       details=$5, bypass_protection=$6, emergency=$7, updated_at=NOW() WHERE code=$1`,
      [code, fields.name, fields.description_tags, fields.operation_voltage, fields.details, fields.bypass_protection, fields.emergency]
    );
    if (record.type === 'DEVICE') await savePins(client, code, req.body.pins || []);
    if (record.type === 'CABLE') await saveCableConnections(client, code, req.body.connections || []);
    await client.query('COMMIT');
    res.json(await detailedRecord(code));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ error: error.message });
  } finally { client.release(); }
});

async function savePins(client, code, pins) {
  if (!isDevice(code)) throw new Error('Only device QR codes can have pins.');
  if (!Array.isArray(pins)) throw new Error('Pins must be an array.');
  const seen = new Set();
  for (const pin of pins) {
    const name = cleanText(pin.pinName, 100);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate pin: ${name}`);
    seen.add(key);
    await client.query(
      `INSERT INTO device_pins(device_code,pin_name,pin_description) VALUES($1,$2,$3)
       ON CONFLICT(device_code,pin_name) DO UPDATE SET pin_description=EXCLUDED.pin_description`,
      [code, name, cleanText(pin.pinDescription, 500)]
    );
  }
  const existing = await client.query('SELECT id,pin_name FROM device_pins WHERE device_code=$1', [code]);
  const keep = new Set([...seen]);
  for (const row of existing.rows) {
    if (!keep.has(row.pin_name.toLowerCase())) {
      await client.query('DELETE FROM device_pins WHERE id=$1', [row.id]);
    }
  }
}

app.post('/api/qr/bulk-deactivate', requireAdmin, async (req, res) => {
  const codes = [...new Set(Array.isArray(req.body.codes) ? req.body.codes : [])].filter(validCode);
  if (!codes.length) return res.status(400).json({ error: 'No valid QR codes selected.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE qr_records SET status='DEACTIVATED', updated_at=NOW() WHERE code=ANY($1) AND status<>'DEACTIVATED' RETURNING code`, [codes]
    );
    await client.query('COMMIT');
    res.json({ deactivated: result.rows.map((r) => r.code) });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: error.message });
  } finally { client.release(); }
});

app.post('/api/qr/bulk-clear', requireAdmin, async (req, res) => {
  const codes = [...new Set(Array.isArray(req.body.codes) ? req.body.codes : [])].filter(validCode);
  if (!codes.length) return res.status(400).json({ error: 'No valid QR codes selected.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query('SELECT code,type,status FROM qr_records WHERE code=ANY($1) FOR UPDATE', [codes]);
    const cleared = [];
    for (const row of rows.rows) {
      if (row.status === 'DEACTIVATED') continue;
      await client.query(
        `UPDATE qr_records SET status='READY', name='', description_tags='{}', operation_voltage='', details='',
         bypass_protection='IGNORE', emergency='IGNORE', updated_at=NOW() WHERE code=$1`, [row.code]
      );
      await client.query('DELETE FROM connections WHERE cable_code=$1', [row.code]);
      await client.query('DELETE FROM device_pins WHERE device_code=$1', [row.code]);
      cleared.push(row.code);
    }
    await client.query('COMMIT');
    res.json({ cleared });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: error.message });
  } finally { client.release(); }
});

app.post('/api/generate', requireAdmin, async (req, res) => {
  const cableAmount = Math.max(0, Math.min(1000, Number(req.body.cableAmount || 0)));
  const deviceAmount = Math.max(0, Math.min(700, Number(req.body.deviceAmount || 0)));
  if (!Number.isInteger(cableAmount) || !Number.isInteger(deviceAmount)) return res.status(400).json({ error: 'Amounts must be whole numbers.' });
  if (cableAmount + deviceAmount === 0) return res.status(400).json({ error: 'Enter at least one QR code.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cableRows = await client.query(`SELECT code FROM qr_records WHERE code BETWEEN '100' AND '299' ORDER BY code`);
    const deviceRows = await client.query(`SELECT code FROM qr_records WHERE code BETWEEN '300' AND '999' ORDER BY code`);
    const cableUsed = new Set(cableRows.rows.map((r) => Number(r.code)));
    const deviceUsed = new Set(deviceRows.rows.map((r) => Number(r.code)));
    const created = [];
    for (let n = 100; n <= 299 && created.filter((x) => x.type === 'CABLE').length < cableAmount; n++) {
      if (cableUsed.has(n)) continue;
      const code = String(n);
      await client.query('INSERT INTO qr_records(code,type,status) VALUES($1,\'CABLE\',\'READY\')', [code]);
      created.push({ code, type: 'CABLE' });
    }
    for (let n = 300; n <= 999 && created.filter((x) => x.type === 'DEVICE').length < deviceAmount; n++) {
      if (deviceUsed.has(n)) continue;
      const code = String(n);
      await client.query('INSERT INTO qr_records(code,type,status) VALUES($1,\'DEVICE\',\'READY\')', [code]);
      created.push({ code, type: 'DEVICE' });
    }
    if (created.filter((x) => x.type === 'CABLE').length !== cableAmount || created.filter((x) => x.type === 'DEVICE').length !== deviceAmount) {
      throw new Error('Not enough unused numbers remain in the requested code ranges.');
    }
    await client.query('COMMIT');
    res.json({ created });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: error.message });
  } finally { client.release(); }
});

app.get('/api/qr/:code/image', async (req, res) => {
  try {
    if (!validCode(req.params.code)) return res.status(400).send('Invalid QR code.');
    const record = await getRecord(req.params.code);
    if (!record) return res.status(404).send('QR code not found.');
    const buffer = await QRCode.toBuffer(req.params.code, { type: 'png', margin: 0, errorCorrectionLevel: 'M', width: 300 });
    res.type('png').send(buffer);
  } catch (error) { res.status(500).send(error.message); }
});

app.post('/api/connections/bulk', requireAdmin, async (req, res) => {
  const first = cleanText(req.body.first, 3);
  const second = cleanText(req.body.second, 3);
  const pin = cleanText(req.body.pin, 200);
  if (!validCode(first) || !validCode(second)) return res.status(400).json({ error: 'Both QR codes must be three digits.' });
  if (first === second) return res.status(400).json({ error: 'You cannot link a QR code to itself.' });

  const firstType = expectedTypeFromCode(first);
  const secondType = expectedTypeFromCode(second);
  if (!firstType || !secondType) return res.status(400).json({ error: 'QR code must be in the supported ranges.' });
  if (firstType === 'DEVICE' && secondType === 'DEVICE') return res.status(400).json({ error: 'Device-to-device linking is not allowed.' });

  const client = await pool.connect();
  const insertedIds = [];
  try {
    await client.query('BEGIN');
    const recs = await client.query('SELECT code,type,status FROM qr_records WHERE code=ANY($1) FOR UPDATE', [[first, second]]);
    if (recs.rows.length !== 2) throw new Error('Both QR codes must exist in the database.');
    if (recs.rows.some((r) => r.status === 'DEACTIVATED')) throw new Error('Deactivated QR codes cannot be linked.');

    if (firstType === 'CABLE' && secondType === 'CABLE') {
      const firstSlots = await client.query('SELECT slot FROM connections WHERE cable_code=$1', [first]);
      const secondSlots = await client.query('SELECT slot FROM connections WHERE cable_code=$1', [second]);
      const firstSlot = [1,2].find((x) => !firstSlots.rows.some((r) => Number(r.slot) === x));
      const secondSlot = [1,2].find((x) => !secondSlots.rows.some((r) => Number(r.slot) === x));
      if (!firstSlot || !secondSlot) throw new Error('At least one of the cables has no free connection slot.');
      const a = await client.query(
        `INSERT INTO connections(cable_code,slot,endpoint_type,endpoint_code,endpoint_pin,descriptive_text)
         VALUES($1,$2,'CABLE',$3,'','Bulk link') RETURNING id`, [first, firstSlot, second]);
      const b = await client.query(
        `INSERT INTO connections(cable_code,slot,endpoint_type,endpoint_code,endpoint_pin,descriptive_text)
         VALUES($1,$2,'CABLE',$3,'','Bulk link') RETURNING id`, [second, secondSlot, first]);
      insertedIds.push(Number(a.rows[0].id), Number(b.rows[0].id));
    } else {
      const cable = firstType === 'CABLE' ? first : second;
      const device = firstType === 'DEVICE' ? first : second;
      if (!pin) throw new Error('Select a device pin before linking cable to device.');
      const pinExists = await client.query('SELECT 1 FROM device_pins WHERE device_code=$1 AND pin_name=$2', [device, pin]);
      if (!pinExists.rowCount) throw new Error(`Pin ${pin} does not exist on device ${device}.`);
      const slots = await client.query('SELECT slot FROM connections WHERE cable_code=$1', [cable]);
      const slot = [1,2].find((x) => !slots.rows.some((r) => Number(r.slot) === x));
      if (!slot) throw new Error('The cable has no free connection slot.');
      const result = await client.query(
        `INSERT INTO connections(cable_code,slot,endpoint_type,endpoint_code,endpoint_pin,descriptive_text)
         VALUES($1,$2,'DEVICE',$3,$4,'Bulk link') RETURNING id`, [cable, slot, device, pin]);
      insertedIds.push(Number(result.rows[0].id));
    }
    const operationId = crypto.randomUUID();
    await client.query('INSERT INTO link_operations(id,action,inserted_connection_ids) VALUES($1,$2,$3)', [operationId, 'BULK_LINK', insertedIds]);
    await client.query('COMMIT');
    res.json({ operationId, insertedConnectionIds: insertedIds });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ error: error.message });
  } finally { client.release(); }
});

app.post('/api/connections/undo/:operationId', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.operationId)) throw new Error('Invalid operation ID.');
    await client.query('BEGIN');
    const op = await client.query('SELECT * FROM link_operations WHERE id=$1 FOR UPDATE', [req.params.operationId]);
    if (!op.rowCount) throw new Error('Operation not found or already undone.');
    const ids = op.rows[0].inserted_connection_ids || [];
    await client.query('DELETE FROM connections WHERE id=ANY($1)', [ids]);
    await client.query('DELETE FROM link_operations WHERE id=$1', [req.params.operationId]);
    await client.query('COMMIT');
    res.json({ undone: ids });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ error: error.message });
  } finally { client.release(); }
});

app.get('/api/device/:code/pins', async (req, res) => {
  try {
    if (!isDevice(req.params.code)) return res.status(400).json({ error: 'Not a device QR code.' });
    const record = await getRecord(req.params.code);
    if (!record) return res.status(404).json({ error: 'Device not found.' });
    res.json(await getPins(req.params.code));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/print-labels', async (req, res) => {
  try {
    const codes = [...new Set(String(req.query.codes || '').split(',').map((x) => x.trim()).filter(validCode))].slice(0, 1000);
    if (!codes.length) return res.status(400).send('No valid codes supplied.');
    const cards = [];
    for (const code of codes) {
      const record = await getRecord(code);
      if (!record) continue;
      const png = await QRCode.toDataURL(code, { margin: 0, errorCorrectionLevel: 'M', width: 180 });
      cards.push(`
        <div class="label">
          <div class="half"><img src="${png}" alt="${code}"><div class="code">${code}</div></div>
          <div class="divider"></div>
          <div class="half"><img src="${png}" alt="${code}"><div class="code">${code}</div></div>
        </div>`);
    }
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>QR Labels</title><style>
      @page{size:A4;margin:5mm}*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;display:flex;flex-wrap:wrap;align-items:flex-start;gap:2mm}.label{width:20mm;height:10mm;border:0.15mm solid #111;display:flex;align-items:center;justify-content:center;page-break-inside:avoid;overflow:hidden}.half{width:9.9mm;height:9.7mm;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden}.half img{width:6.8mm;height:6.8mm;image-rendering:auto}.code{font-size:1.9mm;line-height:1.6mm;height:1.6mm;margin-top:0.2mm;letter-spacing:.2mm}.divider{height:9mm;border-left:.15mm solid #111}@media print{body{gap:1.5mm}}
    </style></head><body>${cards.join('')}<script>window.onload=()=>window.print();</script></body></html>`);
  } catch (error) { res.status(500).send(error.message); }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

ensureDatabase()
  .then(() => {
    app.listen(PORT, () => console.log(`Wiring QR Manager listening on port ${PORT}`));
  })
  .catch((error) => {
    console.error('Database initialization failed:', error);
    process.exit(1);
  });
