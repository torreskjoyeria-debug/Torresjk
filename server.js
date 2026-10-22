const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const mongoose = require('mongoose');

// Ensure robust DNS resolution for MongoDB Atlas SRV records locally (avoid on Vercel AWS Lambda)
if (!process.env.VERCEL) {
  try {
    dns.setServers(['8.8.8.8', '1.1.1.1']);
  } catch (e) {}
}

const app = express();
const PORT = process.env.PORT || 4000;

// ISOLATED DATABASE URI FOR TORRES JOYERÍA (torreskjoyeria_pos)
const DIRECT_MONGO_URI = 'mongodb://torreskjoyeria_db_user:URoLcZKCyxXsc7x3@ac-e37s3f2-shard-00-00.i2bsl70.mongodb.net:27017,ac-e37s3f2-shard-00-01.i2bsl70.mongodb.net:27017,ac-e37s3f2-shard-00-02.i2bsl70.mongodb.net:27017/torreskjoyeria_pos?ssl=true&replicaSet=atlas-14ojy7-shard-0&authSource=admin&retryWrites=true&w=majority';
let MONGO_URI = process.env.MONGO_URI || DIRECT_MONGO_URI;

// STRICT SECURITY GUARD: Ensure this project can ONLY EVER connect to torreskjoyeria_pos and never touches charlesjoyas
if (!MONGO_URI.includes('torreskjoyeria_pos') || MONGO_URI.includes('charlesjoyas')) {
  console.error('⛔ BLOQUEO CRÍTICO DE SEGURIDAD: Conexión denegada. Este proyecto está estrictamente configurado para conectarse ÚNICA Y EXCLUSIVAMENTE a torreskjoyeria_pos.');
  process.exit(1);
}

// If URI uses SRV for cluster0.i2bsl70.mongodb.net, prefer the direct replica set URI to prevent querySrv ECONNREFUSED in serverless environments (AWS/Vercel)
if (MONGO_URI.includes('cluster0.i2bsl70.mongodb.net') && MONGO_URI.startsWith('mongodb+srv://')) {
  MONGO_URI = DIRECT_MONGO_URI;
}

const DB_FILE = path.join(__dirname, 'db.json');

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Security Middleware: Strict restriction on internal database, config and server files
app.use((req, res, next) => {
  const blockedPatterns = [
    /^\/db\.json(\.tmp)?$/i,
    /^\/server\.js$/i,
    /^\/package(-lock)?\.json$/i,
    /^\/scratch(\/|$)/i,
    /^\/\.vscode(\/|$)/i,
    /^\/\.git(\/|$)/i,
    /^\/\.env(\.|$)/i,
    /^\/\.[a-zA-Z0-9_-]+/i
  ];
  if (blockedPatterns.some(regex => regex.test(req.path))) {
    return res.status(403).json({ error: 'Acceso prohibido: Recurso protegido del sistema' });
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Explicit frontend route handler for root requests
app.get(['/', '/index.html'], (req, res) => {
  const publicIndex = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(publicIndex)) {
    return res.sendFile(publicIndex);
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

let mongoConnected = false;
let connectingPromise = null;
let lastMongoError = null;

// Mongoose Schema for general state
const DataSchema = new mongoose.Schema({
  key: { type: String, default: 'main_store', unique: true },
  content: mongoose.Schema.Types.Mixed,
  updatedAt: { type: Date, default: Date.now }
});
const DataModel = mongoose.models.NexusData || mongoose.model('NexusData', DataSchema);

// Robust Serverless-friendly MongoDB Atlas Connection Manager
async function ensureDbConnected() {
  if (mongoose.connection.readyState === 1) {
    mongoConnected = true;
    lastMongoError = null;
    return true;
  }
  if (mongoose.connection.readyState === 2 && connectingPromise) {
    try {
      await connectingPromise;
    } catch (_) {}
    mongoConnected = mongoose.connection.readyState === 1;
    return mongoConnected;
  }
  try {
    connectingPromise = mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 6000,
      socketTimeoutMS: 20000
    });
    await connectingPromise;
    mongoConnected = true;
    lastMongoError = null;
    console.log('[Nexus Server - Torres Joyería] Conectado exitosamente a MongoDB Atlas (torreskjoyeria_pos)');
    return true;
  } catch (err) {
    console.warn('[Nexus Server - Torres Joyería] Error conectando a MongoDB Atlas:', err.message);
    mongoConnected = false;
    lastMongoError = err.message;
    connectingPromise = null;
    return false;
  }
}

// Immediately attempt connection on start
ensureDbConnected().catch(() => {});

// Ensure database connection before executing any /api/ endpoint (guaranteed no hanging)
app.use(async (req, res, next) => {
  if (req.path.startsWith('/api')) {
    try {
      await Promise.race([
        ensureDbConnected(),
        new Promise(r => setTimeout(r, 5500))
      ]);
    } catch (_) {}
  }
  next();
});

const DEFAULT_STORES_LIST = [
  { id: 'store_1', name: 'Sede Principal', code: 'SP', address: 'Avenida Principal # 10 - 20, Local 101', phone: '300 123 4567', email: 'torreskjoyeria@gmail.com', color: '#0284c7' },
  { id: 'store_2', name: 'Sede Centro', code: 'SC', address: 'Calle 48 # 50 - 15, Local 102 (C.C. Centro Joyero)', phone: '310 987 6543', email: 'torreskjoyeria@gmail.com', color: '#0d9488' }
];

// Helper: load local db file (supporting both single-store legacy and multi-store schema)
function loadLocalDb(storeId) {
  if (fs.existsSync(DB_FILE)) {
    try {
      const content = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(content);
      if (storeId) {
        if (parsed.stores && parsed.stores[storeId]) {
          return parsed.stores[storeId];
        }
        if (storeId === 'store_1' && parsed.products) {
          return parsed;
        }
        return null;
      }
      return parsed;
    } catch (e) {
      console.error('[Nexus Server - Cliente 2] Error leyendo db.json:', e);
    }
  }
  return null;
}

// Helper: save local db file atomically per store
function saveLocalDb(data, storeId = 'store_1') {
  if (process.env.VERCEL) {
    return; // Read-only filesystem in Vercel, MongoDB Atlas handles persistence
  }
  const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tmpFile = `${DB_FILE}.tmp.${uniqueSuffix}`;
  try {
    let fullDb = {};
    if (fs.existsSync(DB_FILE)) {
      try {
        fullDb = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      } catch (_) {}
    }
    if (!fullDb.stores) {
      fullDb.stores = {};
    }
    if (!Array.isArray(fullDb.storesList) || fullDb.storesList.length === 0) {
      fullDb.storesList = DEFAULT_STORES_LIST;
    }
    fullDb.activeStoreId = storeId;
    fullDb.stores[storeId] = data;
    fullDb.updatedAt = new Date().toISOString();

    fs.writeFileSync(tmpFile, JSON.stringify(fullDb, null, 2), 'utf8');
    fs.renameSync(tmpFile, DB_FILE);
  } catch (e) {
    console.error('[Nexus Server - Torres Joyería] Error escribiendo db.json:', e);
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch (_) {}
  }
}

// Helper: Merge incoming client full-state with existing persistent state to prevent concurrency data loss
function mergeStoreState(serverData, clientData) {
  if (!serverData || typeof serverData !== 'object') return clientData;
  if (!clientData || typeof clientData !== 'object') return serverData;

  const result = Object.assign({}, clientData);

  // 1. MERGE recentTransactions (Keyed by id, strictly preserve any transaction already committed to server)
  const serverTxs = Array.isArray(serverData.recentTransactions) ? serverData.recentTransactions : [];
  const clientTxs = Array.isArray(clientData.recentTransactions) ? clientData.recentTransactions : [];
  const txMap = new Map();

  serverTxs.forEach(tx => {
    if (tx && tx.id) txMap.set(tx.id, tx);
  });

  clientTxs.forEach(tx => {
    if (tx && tx.id) {
      const existing = txMap.get(tx.id);
      if (existing) {
        txMap.set(tx.id, Object.assign({}, existing, tx));
      } else {
        txMap.set(tx.id, tx);
      }
    }
  });

  result.recentTransactions = Array.from(txMap.values()).sort((a, b) => {
    const timeA = a.timestamp || (a.createdAt ? new Date(a.createdAt).getTime() : 0);
    const timeB = b.timestamp || (b.createdAt ? new Date(b.createdAt).getTime() : 0);
    if (timeA && timeB) return timeB - timeA;
    return (b.id || '').localeCompare(a.id || '');
  });

  // 2. MERGE expenses (Keyed by id)
  const serverExp = Array.isArray(serverData.expenses) ? serverData.expenses : [];
  const clientExp = Array.isArray(clientData.expenses) ? clientData.expenses : [];
  const expMap = new Map();
  serverExp.forEach(e => { if (e && e.id) expMap.set(e.id, e); });
  clientExp.forEach(e => { if (e && e.id) expMap.set(e.id, e); });
  result.expenses = Array.from(expMap.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  // 3. MERGE abonosVentas & abonosCompras (Keyed by id)
  const serverAv = Array.isArray(serverData.abonosVentas) ? serverData.abonosVentas : [];
  const clientAv = Array.isArray(clientData.abonosVentas) ? clientData.abonosVentas : [];
  const avMap = new Map();
  serverAv.forEach(a => { if (a && a.id) avMap.set(a.id, a); });
  clientAv.forEach(a => { if (a && a.id) avMap.set(a.id, a); });
  result.abonosVentas = Array.from(avMap.values());

  const serverAc = Array.isArray(serverData.abonosCompras) ? serverData.abonosCompras : [];
  const clientAc = Array.isArray(clientData.abonosCompras) ? clientData.abonosCompras : [];
  const acMap = new Map();
  serverAc.forEach(a => { if (a && a.id) acMap.set(a.id, a); });
  clientAc.forEach(a => { if (a && a.id) acMap.set(a.id, a); });
  result.abonosCompras = Array.from(acMap.values());

  // 4. MERGE cashShiftsHistory (Keyed by shiftId or id)
  const serverHist = Array.isArray(serverData.cashShiftsHistory) ? serverData.cashShiftsHistory : [];
  const clientHist = Array.isArray(clientData.cashShiftsHistory) ? clientData.cashShiftsHistory : [];
  const histMap = new Map();
  serverHist.forEach(h => { const k = h.shiftId || h.id; if (k) histMap.set(k, h); });
  clientHist.forEach(h => { const k = h.shiftId || h.id; if (k) histMap.set(k, h); });
  result.cashShiftsHistory = Array.from(histMap.values());

  // 5. MERGE customerCredits (Keyed by id or customer)
  const serverCredits = Array.isArray(serverData.customerCredits) ? serverData.customerCredits : [];
  const clientCredits = Array.isArray(clientData.customerCredits) ? clientData.customerCredits : [];
  const creditMap = new Map();
  serverCredits.forEach(c => { const k = c.id || c.customer; if (k) creditMap.set(k, c); });
  clientCredits.forEach(c => { const k = c.id || c.customer; if (k) creditMap.set(k, c); });
  result.customerCredits = Array.from(creditMap.values());

  // 6. MERGE products stock preservation:
  if (Array.isArray(serverData.products) && Array.isArray(clientData.products)) {
    const serverProdMap = new Map();
    serverData.products.forEach(p => { if (p && p.id) serverProdMap.set(p.id, p); });

    result.products = clientData.products.map(clientProd => {
      const serverProd = serverProdMap.get(clientProd.id);
      if (!serverProd) return clientProd;
      const serverSold = Number(serverProd.sold30d) || 0;
      const clientSold = Number(clientProd.sold30d) || 0;
      const mergedProd = Object.assign({}, clientProd);
      if (serverSold > clientSold) {
        mergedProd.sold30d = serverSold;
        mergedProd.stock = Math.min(Number(serverProd.stock) || 0, Number(clientProd.stock) || 0);
        if (mergedProd.stock <= 0) {
          mergedProd.stock = 0;
          mergedProd.status = 'out_of_stock';
        }
      }
      return mergedProd;
    });
  }

  // 7. ACTIVE SHIFT CONSISTENCY:
  if (result.cashShiftLog && result.cashShiftLog.status === 'Abierto') {
    const shift = result.cashShiftLog;
    const shiftId = shift.shiftId;
    let totalCashSales = 0;
    let totalCardSales = 0;

    result.recentTransactions.forEach(tx => {
      const belongs = tx.shiftId ? (tx.shiftId === shiftId) : (!tx.closedShiftId);
      if (belongs) {
        const amt = Math.round(Number(tx.total) || 0);
        const m = (tx.paymentMethod || '').toLowerCase();
        if (tx.paymentBreakdown) {
          totalCashSales += Math.round(Number(tx.paymentBreakdown.cash) || 0);
          totalCardSales += Math.round(Number(tx.paymentBreakdown.card || 0) + Number(tx.paymentBreakdown.transfer || 0) + Number(tx.paymentBreakdown.addi || 0));
        } else if (m.includes('efectivo') || m.includes('cash')) {
          totalCashSales += amt;
        } else if (!m.includes('crédito') && !m.includes('credito')) {
          totalCardSales += amt;
        }
      }
    });

    let totalCashAbonos = 0;
    (result.abonosVentas || []).forEach(a => {
      const belongs = a.shiftId ? (a.shiftId === shiftId) : (!a.closedShiftId);
      if (belongs) {
        const amt = Math.round(Number(a.amount) || 0);
        const m = (a.method || '').toLowerCase();
        if (a.paymentBreakdown) {
          totalCashAbonos += Math.round(Number(a.paymentBreakdown.cash) || 0);
        } else if (m.includes('efectivo') || m.includes('cash')) {
          totalCashAbonos += amt;
        }
      }
    });

    let totalCashExpenses = 0;
    (result.expenses || []).forEach(e => {
      const belongs = e.shiftId ? (e.shiftId === shiftId) : (!e.closedShiftId);
      if (belongs) {
        const m = (e.paymentMethod || e.method || '').toLowerCase();
        if (m.includes('efectivo') || m.includes('cash') || !m.includes('banco')) {
          totalCashExpenses += Math.round(Number(e.amount) || 0);
        }
      }
    });

    shift.cashSales = totalCashSales;
    shift.cardSales = totalCardSales;
    shift.cashExpenses = totalCashExpenses;
    const opening = Number(shift.openingCash) || 0;
    shift.expectedCashInDrawer = opening + totalCashSales + totalCashAbonos - totalCashExpenses;
    if (result.store) {
      result.store.cashInBox = shift.expectedCashInDrawer;
    }
  }

  return result;
}

// API Health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    project: 'Torres Joyería POS - SaaS',
    database: 'torreskjoyeria_pos',
    multiStore: true,
    mongoConnected,
    storageMode: mongoConnected ? 'MongoDB (torreskjoyeria_pos)' : 'Local JSON / Storage',
    lastMongoError,
    uriType: MONGO_URI.startsWith('mongodb+srv') ? 'SRV' : 'Direct ReplicaSet',
    hasEnvMongoUri: !!process.env.MONGO_URI,
    timestamp: new Date()
  });
});

// GET /api/stores - Fetch manifest of stores
app.get('/api/stores', async (req, res) => {
  try {
    if (!mongoConnected) {
      await ensureDbConnected();
    }
    if (mongoConnected) {
      const manifestDoc = await DataModel.findOne({ key: 'stores_manifest' });
      if (manifestDoc && manifestDoc.content && Array.isArray(manifestDoc.content.storesList)) {
        return res.json({ stores: manifestDoc.content.storesList, activeStoreId: manifestDoc.content.activeStoreId || 'store_1' });
      }
    }
    const localDb = loadLocalDb();
    if (localDb && Array.isArray(localDb.storesList)) {
      return res.json({ stores: localDb.storesList, activeStoreId: localDb.activeStoreId || 'store_1' });
    }
    res.json({ stores: DEFAULT_STORES_LIST, activeStoreId: 'store_1' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stores - Save/update stores list metadata
app.post('/api/stores', async (req, res) => {
  try {
    const rawRole = String(req.headers['x-nexus-role'] || '').trim().toLowerCase();
    if (!rawRole.includes('admin')) {
      return res.status(403).json({ error: 'No autorizado: Solo Super Admin puede modificar la red de sedes.' });
    }
    const { stores } = req.body;
    if (!Array.isArray(stores) || stores.length === 0) {
      return res.status(400).json({ error: 'Lista de sedes inválida' });
    }

    if (!process.env.VERCEL && fs.existsSync(DB_FILE)) {
      try {
        const fullDb = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        fullDb.storesList = stores;
        fullDb.updatedAt = new Date().toISOString();
        fs.writeFileSync(DB_FILE, JSON.stringify(fullDb, null, 2), 'utf8');
      } catch (_) {}
    }

    if (!mongoConnected) {
      await ensureDbConnected();
    }
    if (mongoConnected) {
      await DataModel.findOneAndUpdate(
        { key: 'stores_manifest' },
        { content: { storesList: stores, updatedAt: new Date().toISOString() }, updatedAt: new Date() },
        { upsert: true, new: true }
      );
    }
    res.json({ success: true, stores });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/data - Fetch complete store state for a specific isolated store
app.get('/api/data', async (req, res) => {
  try {
    const requestedStoreId = String(req.query.storeId || req.headers['x-nexus-store-id'] || 'store_1').trim();
    const storeId = /^[a-zA-Z0-9_-]+$/.test(requestedStoreId) ? requestedStoreId : 'store_1';

    // Strict access control: if user is constrained to a specific store, forbid fetching another store
    const userStore = String(req.headers['x-nexus-user-store'] || '').trim();
    const userRole = String(req.headers['x-nexus-role'] || '').trim().toLowerCase();
    if (userStore && userStore !== '*' && !userRole.includes('admin') && userStore !== storeId) {
      return res.status(403).json({ error: `Acceso restringido: Tu usuario pertenece a "${userStore}" y no puede consultar "${storeId}".` });
    }

    if (!mongoConnected) {
      await ensureDbConnected();
    }
    if (mongoConnected) {
      const doc = await DataModel.findOne({ key: storeId });
      if (doc && doc.content) {
        return res.json(doc.content);
      }
      if (storeId === 'store_1') {
        const legacyDoc = await DataModel.findOne({ key: 'main_store' });
        if (legacyDoc && legacyDoc.content) {
          return res.json(legacyDoc.content);
        }
      }
    }

    const localData = loadLocalDb(storeId);
    if (localData) {
      return res.json(localData);
    }
    return res.json({ status: 'empty', storeId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/data - Sync isolated full state for a specific store
app.post('/api/data', async (req, res) => {
  try {
    // 1. Authorization check: must have a valid role header from active session
    const rawRole = String(req.headers['x-nexus-role'] || '').trim();
    const userId = String(req.headers['x-nexus-user-id'] || '').trim();
    const roleLower = rawRole.toLowerCase();
    const isAllowed = 
      roleLower.includes('admin') || 
      roleLower.includes('cajer') || 
      roleLower.includes('gerente') || 
      roleLower.includes('supervisor') || 
      roleLower.includes('contad') || 
      roleLower.includes('inventario') ||
      userId.startsWith('USR-');

    if (!rawRole || !userId || !isAllowed) {
      return res.status(403).json({ error: 'No autorizado: Se requiere una sesión válida para sincronizar datos.' });
    }

    const requestedStoreId = String(req.query.storeId || req.headers['x-nexus-store-id'] || 'store_1').trim();
    const storeId = /^[a-zA-Z0-9_-]+$/.test(requestedStoreId) ? requestedStoreId : 'store_1';

    // Strict access control: verify user store ownership
    const userStore = String(req.headers['x-nexus-user-store'] || '').trim();
    if (userStore && userStore !== '*' && !roleLower.includes('admin') && userStore !== storeId) {
      return res.status(403).json({ error: `Acceso restringido: No tienes permiso para modificar la sede "${storeId}".` });
    }

    // 2. Strict multi-property schema validation to prevent DB corruption
    const data = req.body;
    if (
      !data || 
      typeof data !== 'object' || 
      !Array.isArray(data.products) || 
      !Array.isArray(data.users) || 
      !Array.isArray(data.perfiles) || 
      !data.store
    ) {
      return res.status(400).json({ error: 'Payload de datos inválido o incompleto: estructura requerida ausente' });
    }

    if (!mongoConnected) {
      await ensureDbConnected();
    }

    // SMART CONCURRENCY MERGE: Prevent terminal saves from overwriting other active cashiers' transactions, expenses, debts, shifts
    let mergedData = data;
    if (mongoConnected) {
      const existingDoc = await DataModel.findOne({ key: storeId });
      if (existingDoc && existingDoc.content) {
        mergedData = mergeStoreState(existingDoc.content, data);
      }
    } else {
      const localExisting = loadLocalDb(storeId);
      if (localExisting) {
        mergedData = mergeStoreState(localExisting, data);
      }
    }

    mergedData.updatedAt = new Date().toISOString();
    saveLocalDb(mergedData, storeId);

    if (mongoConnected) {
      await DataModel.findOneAndUpdate(
        { key: storeId },
        { content: mergedData, updatedAt: new Date() },
        { upsert: true, new: true }
      );
      if (storeId === 'store_1') {
        await DataModel.findOneAndUpdate(
          { key: 'main_store' },
          { content: mergedData, updatedAt: new Date() },
          { upsert: true, new: true }
        );
      }
    } else if (process.env.VERCEL) {
      return res.status(503).json({ error: 'Error de persistencia: No se pudo conectar a MongoDB Atlas en Vercel.' });
    }

    res.json({ 
      success: true, 
      storeId, 
      mode: mongoConnected ? 'MongoDB (torreskjoyeria_pos)' : 'Local JSON', 
      recentTransactionsCount: (mergedData.recentTransactions || []).length,
      mergedTransactions: mergedData.recentTransactions,
      updatedAt: mergedData.updatedAt,
      timestamp: new Date() 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

if (!process.env.VERCEL && require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Nexus Server - Torres Joyería] Servidor corriendo en http://localhost:${PORT}`);
    console.log(`[Nexus Server - Torres Joyería] Base de datos asignada: torreskjoyeria_pos`);
  });
}

module.exports = app;
