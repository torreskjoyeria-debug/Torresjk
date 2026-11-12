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
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
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
function mergeStoreState(serverData, clientData, isAdmin = false) {
  if (!serverData || typeof serverData !== 'object') return clientData;
  if (!clientData || typeof clientData !== 'object') return serverData;

  const result = Object.assign({}, clientData);
  const nowMs = Date.now();

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
        const mergedTx = Object.assign({}, existing, tx);
        const existSt = String(existing.status || '').toLowerCase();
        const clientSt = String(tx.status || '').toLowerCase();
        if ((existSt === 'anulado' || existSt === 'cancelado') && clientSt !== 'anulado' && clientSt !== 'cancelado') {
          mergedTx.status = existing.status;
          if (existing.anuladoAt) mergedTx.anuladoAt = existing.anuladoAt;
          if (existing.anuladoBy) mergedTx.anuladoBy = existing.anuladoBy;
        }
        txMap.set(tx.id, mergedTx);
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

  // Server-side Deduplication Guard:
  // Discard duplicate sales generated by double-clicking or concurrent requests
  const deduplicatedTxs = [];
  result.recentTransactions.forEach(tx => {
    const isDup = deduplicatedTxs.some(existing => {
      if (existing.date !== tx.date) return false;
      if (Math.abs((Number(existing.total) || 0) - (Number(tx.total) || 0)) > 0.01) return false;
      if ((existing.cashier || '') !== (tx.cashier || '')) return false;

      const ts1 = existing.timestamp || (existing.createdAt ? new Date(existing.createdAt).getTime() : 0);
      const ts2 = tx.timestamp || (tx.createdAt ? new Date(tx.createdAt).getTime() : 0);
      const timeDiff = (ts1 && ts2) ? Math.abs(ts1 - ts2) : 0;
      const sameTimeStr = (existing.time || '') === (tx.time || '');

      if (timeDiff > 5000 && !sameTimeStr) return false;

      const sig1 = (existing.items || []).map(i => `${i.id || i.sku}_${i.qty || i.quantity}_${i.price}`).sort().join('|');
      const sig2 = (tx.items || []).map(i => `${i.id || i.sku}_${i.qty || i.quantity}_${i.price}`).sort().join('|');
      return sig1.length > 0 && sig1 === sig2;
    });

    if (!isDup) {
      deduplicatedTxs.push(tx);
    } else {
      console.warn(`[NexusServer] Venta duplicada descartada automáticamente: ID=${tx.id}, Total=${tx.total}, Cajero=${tx.cashier}`);
    }
  });
  result.recentTransactions = deduplicatedTxs;

  // 2. DELETED EXPENSES BLACKLIST & EXPENSES MERGE:
  // Strictly prevent deleted expenses from resurrecting via server merge
  const deletedExpenses = new Set([
    ...(Array.isArray(clientData.deletedExpenses) ? clientData.deletedExpenses : []),
    ...(Array.isArray(serverData.deletedExpenses) ? serverData.deletedExpenses : [])
  ]);

  const serverExp = Array.isArray(serverData.expenses) ? serverData.expenses : [];
  const clientExp = Array.isArray(clientData.expenses) ? clientData.expenses : [];

  // If an authorized admin/user explicitly submitted expenses, any expense absent in clientExp is marked deleted
  if (isAdmin && Array.isArray(clientData.expenses)) {
    const clientExpIds = new Set(clientExp.map(e => e && e.id).filter(Boolean));
    serverExp.forEach(se => {
      if (se && se.id && !clientExpIds.has(se.id)) {
        const itemTs = Number(se.createdAt || se.timestamp) || 0;
        if (!itemTs || (nowMs - itemTs > 120000)) {
          deletedExpenses.add(se.id);
        }
      }
    });
  }
  result.deletedExpenses = Array.from(deletedExpenses);

  const expMap = new Map();
  serverExp.forEach(e => {
    if (e && e.id && !deletedExpenses.has(e.id)) {
      expMap.set(e.id, e);
    }
  });
  clientExp.forEach(e => {
    if (e && e.id && !deletedExpenses.has(e.id)) {
      expMap.set(e.id, e);
    }
  });
  result.expenses = Array.from(expMap.values())
    .filter(e => e && e.id && !deletedExpenses.has(e.id))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  // 3. MERGE abonosVentas & abonosCompras (Keyed by id)
  const serverAv = Array.isArray(serverData.abonosVentas) ? serverData.abonosVentas : [];
  const clientAv = Array.isArray(clientData.abonosVentas) ? clientData.abonosVentas : [];
  const avMap = new Map();
  serverAv.forEach(a => { if (a && a.id) avMap.set(a.id, a); });
  clientAv.forEach(a => { if (a && a.id) avMap.set(a.id, a); });
  result.abonosVentas = Array.from(avMap.values());

  const deletedAbonosCompras = new Set([
    ...(Array.isArray(clientData.deletedAbonosCompras) ? clientData.deletedAbonosCompras : []),
    ...(Array.isArray(serverData.deletedAbonosCompras) ? serverData.deletedAbonosCompras : [])
  ]);

  const serverAc = Array.isArray(serverData.abonosCompras) ? serverData.abonosCompras : [];
  const clientAc = Array.isArray(clientData.abonosCompras) ? clientData.abonosCompras : [];

  if (isAdmin && Array.isArray(clientData.abonosCompras)) {
    const clientAcIds = new Set(clientAc.map(a => a && a.id).filter(Boolean));
    serverAc.forEach(sa => {
      if (sa && sa.id && !clientAcIds.has(sa.id)) {
        const itemTs = Number(sa.createdAt || sa.timestamp) || 0;
        if (!itemTs || (nowMs - itemTs > 120000)) {
          deletedAbonosCompras.add(sa.id);
        }
      }
    });
  }
  result.deletedAbonosCompras = Array.from(deletedAbonosCompras);

  const acMap = new Map();
  serverAc.forEach(a => {
    if (a && a.id && !deletedAbonosCompras.has(a.id)) {
      acMap.set(a.id, a);
    }
  });
  clientAc.forEach(a => {
    if (a && a.id && !deletedAbonosCompras.has(a.id)) {
      acMap.set(a.id, a);
    }
  });
  result.abonosCompras = Array.from(acMap.values()).filter(a => a && a.id && !deletedAbonosCompras.has(a.id));

  // 4. MERGE cashShiftsHistory (Keyed by shiftId or id)
  const serverHist = Array.isArray(serverData.cashShiftsHistory) ? serverData.cashShiftsHistory : [];
  const clientHist = Array.isArray(clientData.cashShiftsHistory) ? clientData.cashShiftsHistory : [];
  const histMap = new Map();
  serverHist.forEach(h => { const k = h.shiftId || h.id; if (k) histMap.set(k, h); });
  clientHist.forEach(h => { const k = h.shiftId || h.id; if (k) histMap.set(k, h); });
  result.cashShiftsHistory = Array.from(histMap.values());

  // Helper: Merge CRUD collections with persistent deletion blacklists & timestamp-aware conflict resolution
  const mergeCrudCollection = (colKey, delKey, fallbackKeyProp = null) => {
    const deletedSet = new Set(
      [
        ...(Array.isArray(clientData[delKey]) ? clientData[delKey] : []),
        ...(Array.isArray(serverData[delKey]) ? serverData[delKey] : [])
      ].map(id => String(id || '').trim()).filter(Boolean)
    );

    const serverArr = Array.isArray(serverData[colKey]) ? serverData[colKey] : [];
    const clientArr = Array.isArray(clientData[colKey]) ? clientData[colKey] : [];

    const getKey = (item) => {
      if (!item) return '';
      if (item.id) return String(item.id).trim();
      if (fallbackKeyProp && item[fallbackKeyProp]) return String(item[fallbackKeyProp]).trim();
      return '';
    };

    if (isAdmin && Array.isArray(clientData[colKey])) {
      const clientKeys = new Set(clientArr.map(getKey).filter(Boolean));
      const clientNames = fallbackKeyProp
        ? new Set(clientArr.map(item => item && item[fallbackKeyProp] ? String(item[fallbackKeyProp]).toLowerCase().trim() : '').filter(Boolean))
        : new Set();

      serverArr.forEach(sItem => {
        const k = getKey(sItem);
        if (!k) return;
        const fName = (fallbackKeyProp && sItem[fallbackKeyProp]) ? String(sItem[fallbackKeyProp]).toLowerCase().trim() : '';
        const existsInClient = clientKeys.has(k) || (fName && clientNames.has(fName));
        if (!existsInClient) {
          const itemTs = Number(sItem.createdAt || sItem.timestamp) || 0;
          if (!itemTs || (nowMs - itemTs > 120000)) {
            deletedSet.add(k);
          }
        }
      });
    }

    result[delKey] = Array.from(deletedSet);

    const itemMap = new Map();
    serverArr.forEach(sItem => {
      const k = getKey(sItem);
      if (k && !deletedSet.has(k)) {
        itemMap.set(k, sItem);
      }
    });

    clientArr.forEach(cItem => {
      const k = getKey(cItem);
      if (!k || deletedSet.has(k)) return;
      const existing = itemMap.get(k);
      if (!existing) {
        itemMap.set(k, cItem);
      } else {
        const sTs = Number(existing.updatedAt || existing.createdAt || existing.timestamp) || 0;
        const cTs = Number(cItem.updatedAt || cItem.createdAt || cItem.timestamp) || 0;
        const preferServerOnTie = !isAdmin && colKey !== 'customers' && colKey !== 'customerCredits';
        if (sTs > cTs || (preferServerOnTie && sTs === cTs)) {
          itemMap.set(k, Object.assign({}, cItem, existing));
        } else {
          itemMap.set(k, Object.assign({}, existing, cItem));
        }
      }
    });

    result[colKey] = Array.from(itemMap.values()).filter(item => {
      const k = getKey(item);
      return k && !deletedSet.has(k);
    });
    return deletedSet;
  };

  // 5. MERGE customers, suppliers, and their credits with deletion blacklists
  const deletedCustomers = mergeCrudCollection('customers', 'deletedCustomers', 'name');
  const deletedCustomerCredits = mergeCrudCollection('customerCredits', 'deletedCustomerCredits', 'customer');
  const deletedSuppliers = mergeCrudCollection('suppliers', 'deletedSuppliers', 'name');

  // Purge orphan customerCredits belonging to deleted customers
  if (deletedCustomers.size > 0 && Array.isArray(result.customerCredits)) {
    const activeCustNames = new Set(
      (result.customers || []).map(c => c && c.name ? String(c.name).toLowerCase().trim() : '').filter(Boolean)
    );
    const deletedCustNames = new Set(
      (Array.isArray(serverData.customers) ? serverData.customers : [])
        .filter(c => c && c.id && deletedCustomers.has(String(c.id).trim()) && c.name)
        .map(c => String(c.name).toLowerCase().trim())
        .filter(n => n && !activeCustNames.has(n))
    );
    result.customerCredits = result.customerCredits.filter(cc => {
      if (!cc) return false;
      const matchId = cc.customerId && deletedCustomers.has(String(cc.customerId).trim());
      const matchName = cc.customer && deletedCustNames.has(String(cc.customer).toLowerCase().trim());
      if (matchId || matchName) {
        if (cc.id) deletedCustomerCredits.add(String(cc.id).trim());
        return false;
      }
      return true;
    });
    result.deletedCustomerCredits = Array.from(deletedCustomerCredits);
  }

  // 5b. DELETED PURCHASES BLACKLIST & PURCHASES MERGE:
  // Strictly prevent deleted purchases from resurrecting via server merge
  const deletedPurchases = new Set([
    ...(Array.isArray(clientData.deletedPurchases) ? clientData.deletedPurchases : []),
    ...(Array.isArray(serverData.deletedPurchases) ? serverData.deletedPurchases : [])
  ]);

  const serverPurchases = Array.isArray(serverData.purchases) ? serverData.purchases : [];
  const clientPurchases = Array.isArray(clientData.purchases) ? clientData.purchases : [];

  // If an authorized admin explicitly submitted purchases, any purchase absent in clientPurchases is marked deleted
  if (isAdmin && Array.isArray(clientData.purchases)) {
    const clientPoIds = new Set(clientPurchases.map(p => p && p.id).filter(Boolean));
    serverPurchases.forEach(sp => {
      if (sp && sp.id && !clientPoIds.has(sp.id)) {
        const itemTs = Number(sp.createdAt || sp.timestamp) || 0;
        if (!itemTs || (nowMs - itemTs > 120000)) {
          deletedPurchases.add(sp.id);
        }
      }
    });
  }
  result.deletedPurchases = Array.from(deletedPurchases);

  const poMap = new Map();
  serverPurchases.forEach(po => {
    if (po && po.id && !deletedPurchases.has(po.id)) {
      poMap.set(po.id, po);
    }
  });
  clientPurchases.forEach(po => {
    if (po && po.id && !deletedPurchases.has(po.id)) {
      poMap.set(po.id, po);
    }
  });

  // Server-side Deduplication Guard:
  // Discard duplicate purchase orders generated by double-clicking or rapid concurrent requests
  const deduplicatedPOs = [];
  Array.from(poMap.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).forEach(po => {
    const isDup = deduplicatedPOs.some(existing => {
      if (existing.date !== po.date) return false;
      if (existing.productId !== po.productId && (existing.productSku || '') !== (po.productSku || '')) return false;
      if (Math.abs((Number(existing.quantity) || 0) - (Number(po.quantity) || 0)) > 0.0001) return false;
      if (Math.abs((Number(existing.total) || 0) - (Number(po.total) || 0)) > 0.01) return false;

      const ts1 = existing.timestamp || (existing.date ? new Date(existing.date).getTime() : 0);
      const ts2 = po.timestamp || (po.date ? new Date(po.date).getTime() : 0);
      const timeDiff = (ts1 && ts2) ? Math.abs(ts1 - ts2) : 0;
      const sameTimeStr = (existing.time || '') === (po.time || '');

      return timeDiff < 15000 || sameTimeStr;
    });

    if (!isDup) {
      deduplicatedPOs.push(po);
    } else {
      console.warn(`[NexusServer] Orden de compra duplicada descartada automáticamente: ID=${po.id}, Producto=${po.productName}, Total=${po.total}`);
    }
  });
  result.purchases = deduplicatedPOs;

  // 5c. MERGE supplierCredits with deletion blacklist & cascade cleanup (matched by supplier identity + ID)
  const deletedSupplierCredits = new Set(
    [
      ...(Array.isArray(clientData.deletedSupplierCredits) ? clientData.deletedSupplierCredits : []),
      ...(Array.isArray(serverData.deletedSupplierCredits) ? serverData.deletedSupplierCredits : [])
    ].map(id => String(id || '').trim()).filter(Boolean)
  );
  const explicitClientDeletedSc = new Set(
    (Array.isArray(clientData.deletedSupplierCredits) ? clientData.deletedSupplierCredits : [])
      .map(id => String(id || '').trim()).filter(Boolean)
  );

  const getScSuppKey = (sc) => {
    if (!sc) return '';
    const sName = String(sc.supplier || sc.supplierId || sc.id || '').toLowerCase().trim();
    if (!sName) return '';
    const state = (Number(sc.pendingAmount) > 0 && sc.status !== 'Pagado Total') ? 'pending' : 'paid';
    return `${sName}__${state}`;
  };

  const serverSuppCredits = Array.isArray(serverData.supplierCredits) ? serverData.supplierCredits : [];
  const clientSuppCredits = Array.isArray(clientData.supplierCredits) ? clientData.supplierCredits : [];
  const newlyDeletedScObjects = [];

  if (isAdmin && Array.isArray(clientData.supplierCredits)) {
    const clientScSuppKeys = new Set(clientSuppCredits.map(getScSuppKey).filter(Boolean));
    serverSuppCredits.forEach(sSc => {
      if (!sSc) return;
      const scId = String(sSc.id || '').trim();
      const sKey = getScSuppKey(sSc);
      const explicitlyDeleted = scId && explicitClientDeletedSc.has(scId);
      const missingBySupplier = sKey && !clientScSuppKeys.has(sKey);
      if (explicitlyDeleted || missingBySupplier) {
        const itemTs = Number(sSc.createdAt || sSc.timestamp) || 0;
        if (explicitlyDeleted || !itemTs || (nowMs - itemTs > 120000)) {
          if (scId) deletedSupplierCredits.add(scId);
          if (sKey) deletedSupplierCredits.add(`suppkey:${sKey}`);
          newlyDeletedScObjects.push(sSc);
        }
      }
    });

    // If admin created a fresh credit for a supplier, un-blacklist its suppkey
    clientSuppCredits.forEach(cSc => {
      if (!cSc) return;
      const scId = String(cSc.id || '').trim();
      if (scId && explicitClientDeletedSc.has(scId)) return;
      const sKey = getScSuppKey(cSc);
      if (sKey && deletedSupplierCredits.has(`suppkey:${sKey}`)) {
        const cTs = Number(cSc.updatedAt || cSc.createdAt || cSc.timestamp) || 0;
        if (cTs && (nowMs - cTs < 120000)) {
          deletedSupplierCredits.delete(`suppkey:${sKey}`);
        }
      }
    });

    const scMap = new Map();
    clientSuppCredits.forEach(cSc => {
      if (!cSc) return;
      const scId = String(cSc.id || '').trim();
      const sKey = getScSuppKey(cSc);
      if (scId && explicitClientDeletedSc.has(scId)) return;
      if (sKey && deletedSupplierCredits.has(`suppkey:${sKey}`)) return;
      scMap.set(sKey || scId, Object.assign({}, cSc));
    });
    serverSuppCredits.forEach(sSc => {
      if (!sSc) return;
      const scId = String(sSc.id || '').trim();
      const sKey = getScSuppKey(sSc);
      if ((scId && deletedSupplierCredits.has(scId)) || (sKey && deletedSupplierCredits.has(`suppkey:${sKey}`))) return;
      if (!scMap.has(sKey || scId)) {
        scMap.set(sKey || scId, Object.assign({}, sSc));
      }
    });
    result.supplierCredits = Array.from(scMap.values());
  } else {
    const scMap = new Map();
    serverSuppCredits.forEach(sSc => {
      if (!sSc) return;
      const scId = String(sSc.id || '').trim();
      const sKey = getScSuppKey(sSc);
      if ((scId && deletedSupplierCredits.has(scId)) || (sKey && deletedSupplierCredits.has(`suppkey:${sKey}`))) return;
      scMap.set(sKey || scId, Object.assign({}, sSc));
    });
    clientSuppCredits.forEach(cSc => {
      if (!cSc) return;
      const scId = String(cSc.id || '').trim();
      const sKey = getScSuppKey(cSc);
      if ((scId && deletedSupplierCredits.has(scId)) || (sKey && deletedSupplierCredits.has(`suppkey:${sKey}`))) return;
      const existing = scMap.get(sKey || scId);
      if (!existing) {
        scMap.set(sKey || scId, Object.assign({}, cSc));
      } else {
        const sTs = Number(existing.updatedAt || existing.createdAt || 0) || 0;
        const cTs = Number(cSc.updatedAt || cSc.createdAt || 0) || 0;
        if (cTs > sTs) {
          scMap.set(sKey || scId, Object.assign({}, existing, cSc));
        }
      }
    });
    result.supplierCredits = Array.from(scMap.values());
  }

  // If any supplier was deleted, also purge its supplierCredits
  if (deletedSuppliers.size > 0 && Array.isArray(result.supplierCredits)) {
    const activeSuppNames = new Set(
      (result.suppliers || []).map(s => s && s.name ? String(s.name).toLowerCase().trim() : '').filter(Boolean)
    );
    const deletedSuppNames = new Set(
      (Array.isArray(serverData.suppliers) ? serverData.suppliers : [])
        .filter(s => s && s.id && deletedSuppliers.has(String(s.id).trim()) && s.name)
        .map(s => String(s.name).toLowerCase().trim())
        .filter(n => n && !activeSuppNames.has(n))
    );
    result.supplierCredits = result.supplierCredits.filter(sc => {
      if (!sc) return false;
      const matchId = sc.supplierId && deletedSuppliers.has(String(sc.supplierId).trim());
      const matchName = sc.supplier && deletedSuppNames.has(String(sc.supplier).toLowerCase().trim());
      if (matchId || matchName) {
        if (sc.id) deletedSupplierCredits.add(String(sc.id).trim());
        const sKey = getScSuppKey(sc);
        if (sKey) deletedSupplierCredits.add(`suppkey:${sKey}`);
        return false;
      }
      return true;
    });
  }
  result.deletedSupplierCredits = Array.from(deletedSupplierCredits);

  // If a supplierCredit was deleted, ensure its supplier creditBalance is 0 and linked POs are marked paid
  if (newlyDeletedScObjects.length > 0 || deletedSupplierCredits.size > 0) {
    const checkScList = newlyDeletedScObjects.length > 0 ? newlyDeletedScObjects : serverSuppCredits.filter(oldSc =>
      oldSc && ((oldSc.id && deletedSupplierCredits.has(String(oldSc.id).trim())) || deletedSupplierCredits.has(`suppkey:${getScSuppKey(oldSc)}`))
    );
    checkScList.forEach(oldSc => {
      if (!oldSc) return;
      const scSuppNorm = String(oldSc.supplier || '').toLowerCase().trim();
      const scSuppId = String(oldSc.supplierId || '').trim();
      const stillHasActiveCredit = (result.supplierCredits || []).some(activeSc =>
        activeSc &&
        ((scSuppId && String(activeSc.supplierId || '').trim() === scSuppId) ||
         (scSuppNorm && String(activeSc.supplier || '').toLowerCase().trim() === scSuppNorm)) &&
        Number(activeSc.pendingAmount) > 0
      );
      if (!stillHasActiveCredit) {
        if (Array.isArray(result.suppliers)) {
          const supp = result.suppliers.find(s =>
            s && ((scSuppId && String(s.id || '').trim() === scSuppId) ||
                  (scSuppNorm && String(s.name || '').toLowerCase().trim() === scSuppNorm))
          );
          if (supp && Number(supp.creditBalance) > 0) {
            supp.creditBalance = 0;
            supp.updatedAt = nowMs;
          }
        }
        if (Array.isArray(result.purchases)) {
          const linkedPoIds = new Set(Array.isArray(oldSc.purchaseOrderIds) ? oldSc.purchaseOrderIds : (oldSc.poId ? [oldSc.poId] : []));
          result.purchases.forEach(po => {
            if (!po) return;
            const poSuppNorm = String(po.supplier || '').toLowerCase().trim();
            if (linkedPoIds.has(po.id) || (scSuppNorm && poSuppNorm === scSuppNorm && po.paymentStatus !== 'Pagado Total')) {
              po.paymentStatus = 'Pagado Total';
              po.paidAmount = Number(po.total) || 0;
            }
          });
        }
      }
    });
  }

  // Purge any references to deleted purchases in supplierCredits and abonosCompras
  if (deletedPurchases.size > 0) {
    if (Array.isArray(result.supplierCredits)) {
      result.supplierCredits.forEach(sc => {
        if (sc && Array.isArray(sc.purchaseOrderIds)) {
          sc.purchaseOrderIds = sc.purchaseOrderIds.filter(pid => !deletedPurchases.has(pid));
        }
      });
      result.supplierCredits = result.supplierCredits.filter(sc => {
        if (!sc) return false;
        if (deletedPurchases.has(sc.poId) || deletedPurchases.has(sc.id)) {
          if (!sc.purchaseOrderIds || sc.purchaseOrderIds.length === 0) return false;
        }
        return true;
      });
    }
    if (Array.isArray(result.abonosCompras)) {
      result.abonosCompras = result.abonosCompras.filter(ab => !ab || !deletedPurchases.has(ab.poId));
    }
  }

  // 5d. MERGE categories, services, assets, users, perfiles, and paymentMethods with deletion blacklists
  mergeCrudCollection('categories', 'deletedCategories', 'name');
  mergeCrudCollection('services', 'deletedServices', 'name');
  mergeCrudCollection('assets', 'deletedAssets', 'name');
  mergeCrudCollection('users', 'deletedUsers', 'email');
  mergeCrudCollection('perfiles', 'deletedPerfiles', 'name');
  mergeCrudCollection('paymentMethods', 'deletedPaymentMethods', 'name');

  // 6. DELETED PRODUCTS BLACKLIST & PRODUCTS MERGE:
  // Strictly prevent deleted products from resurrecting via server merge (keyed strictly by ID)
  const deletedProducts = new Set([
    ...(Array.isArray(clientData.deletedProducts) ? clientData.deletedProducts : []),
    ...(Array.isArray(serverData.deletedProducts) ? serverData.deletedProducts : [])
  ]);
  result.deletedProducts = Array.from(deletedProducts);

  if (Array.isArray(serverData.products) && Array.isArray(clientData.products)) {
    const serverProdMap = new Map();
    serverData.products.forEach(p => { 
      if (p && p.id && !deletedProducts.has(p.id)) serverProdMap.set(p.id, p); 
    });

    const nowMs = Date.now();
    const serverTxIds = new Set(serverTxs.map(t => t && t.id).filter(Boolean));
    const clientTxIds = new Set(clientTxs.map(t => t && t.id).filter(Boolean));
    const newClientTxs = deduplicatedTxs.filter(tx => {
      if (!tx || !tx.id || serverTxIds.has(tx.id)) return false;
      const ts = tx.timestamp || (tx.createdAt ? new Date(tx.createdAt).getTime() : nowMs);
      return Math.abs(nowMs - ts) < 15 * 60 * 1000;
    });
    const missedServerTxs = serverTxs.filter(tx => tx && tx.id && !clientTxIds.has(tx.id));

    const getProductDeductFromTxs = (prod, txList) => {
      if (!prod || !Array.isArray(txList) || txList.length === 0) return 0;
      const pWeight = parseFloat(String(prod.pieceWeight !== undefined && prod.pieceWeight !== null ? prod.pieceWeight : (prod.weight || 0)).replace(',', '.')) || 0;
      const stockNum = parseFloat(String(prod.stock || 0).replace(',', '.')) || 0;
      const isPesaje = (prod.measureType || 'Pesaje') === 'Pesaje' || (pWeight <= 0 && stockNum > 0 && (stockNum % 1 !== 0));
      const isUnitWithWeight = !isPesaje && pWeight > 0;
      let totalDeduct = 0;

      txList.forEach(tx => {
        if (!tx || !Array.isArray(tx.items)) return;
        tx.items.forEach(it => {
          if (!it) return;
          const matchesId = it.id && prod.id && it.id === prod.id;
          if (!matchesId) return;

          const rawQty = Number(it.qty) || 0;
          if (rawQty <= 0) return;

          if (isPesaje) {
            totalDeduct += rawQty;
          } else if (isUnitWithWeight) {
            if (it.unitsCount !== undefined && it.unitsCount !== null && Number(it.unitsCount) > 0) {
              totalDeduct += Math.max(1, Math.round(Number(it.unitsCount)));
            } else if (rawQty >= 1 && (rawQty % 1 === 0) && (pWeight % 1 !== 0)) {
              // Safeguard for legacy un-refreshed tabs where cashier typed integer units (e.g. 2) into the gram input
              totalDeduct += Math.round(rawQty);
            } else {
              const rawUnits = rawQty / pWeight;
              totalDeduct += Math.max(1, Math.round(rawUnits));
            }
          } else {
            const u = (it.unitsCount !== undefined && it.unitsCount !== null && Number(it.unitsCount) > 0)
              ? Number(it.unitsCount)
              : rawQty;
            totalDeduct += Math.max(1, Math.round(u));
          }
        });
      });

      return Math.round(totalDeduct * 10000) / 10000;
    };

    // Safeguard for un-refreshed client tabs: if a newly created product (_explicitStockEdit: true)
    // was assigned an ID that collides with deletedProducts, re-assign it a fresh unique ID
    // instead of discarding the user's new product.
    let maxProdIdNum = 0;
    const allKnownProdIds = new Set();
    const trackProdId = (idVal) => {
      if (!idVal) return;
      const clean = String(idVal).trim();
      allKnownProdIds.add(clean);
      const m = clean.match(/^PRD-(\d+)$/i);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!isNaN(n) && n > maxProdIdNum) maxProdIdNum = n;
      }
    };
    serverData.products.forEach(p => { if (p && p.id) trackProdId(p.id); });
    clientData.products.forEach(p => { if (p && p.id) trackProdId(p.id); });
    deletedProducts.forEach(delId => trackProdId(delId));

    clientData.products.forEach(p => {
      if (p && p.id && p._explicitStockEdit && deletedProducts.has(p.id) && !serverProdMap.has(p.id)) {
        const oldId = p.id;
        maxProdIdNum++;
        let newId = `PRD-${String(maxProdIdNum).padStart(3, '0')}`;
        while (allKnownProdIds.has(newId)) {
          maxProdIdNum++;
          newId = `PRD-${String(maxProdIdNum).padStart(3, '0')}`;
        }
        allKnownProdIds.add(newId);
        p.id = newId;
        if (p.sku === oldId) p.sku = newId;
        if (Array.isArray(result.purchases)) {
          result.purchases.forEach(po => {
            if (po && po.productId === oldId) po.productId = newId;
          });
        }
      }
    });

    const mergedProducts = clientData.products
      .filter(p => p && p.id && !deletedProducts.has(p.id))
      .map(clientProd => {
        const serverProd = clientProd && clientProd.id ? serverProdMap.get(clientProd.id) : null;
        if (!serverProd) {
          const freshProd = Object.assign({}, clientProd);
          delete freshProd._explicitStockEdit;
          if (!freshProd.stockUpdatedAt) freshProd.stockUpdatedAt = nowMs;
          return freshProd;
        }

        // 1. Explicit product edit or purchase update from client
        if (clientProd._explicitStockEdit) {
          const mergedProd = Object.assign({}, clientProd);
          delete mergedProd._explicitStockEdit;
          mergedProd.stockUpdatedAt = nowMs;
          if (!mergedProd.sku && serverProd.sku) mergedProd.sku = serverProd.sku;
          if (!mergedProd.code && serverProd.code) mergedProd.code = serverProd.code;
          return mergedProd;
        }

        // 2. POS Sale submission: deduct only the exact sold units from serverProd.stock
        // and preserve serverProd for all products not involved in this sale
        if (newClientTxs.length > 0) {
          const soldInNewTx = getProductDeductFromTxs(serverProd, newClientTxs);
          if (soldInNewTx > 0) {
            const mergedProd = Object.assign({}, serverProd);
            mergedProd.stock = Math.max(0, Math.round(((Number(serverProd.stock) || 0) - soldInNewTx) * 10000) / 10000);
            if (mergedProd.stock <= 0) {
              mergedProd.stock = 0;
              mergedProd.status = 'out_of_stock';
            } else if (mergedProd.stock <= (Number(mergedProd.minStock) || 0)) {
              mergedProd.status = 'low_stock';
            } else {
              mergedProd.status = 'active';
            }
            mergedProd.sold30d = Math.round(((Number(serverProd.sold30d) || 0) + soldInNewTx) * 10000) / 10000;
            if (clientProd.monthlySales) {
              mergedProd.monthlySales = clientProd.monthlySales;
            }
            mergedProd.stockUpdatedAt = nowMs;
            return mergedProd;
          }
          return Object.assign({}, serverProd);
        }

        // 3. Non-sale submission without _explicitStockEdit:
        // Protect serverProd if it was updated more recently or sold in missedServerTxs
        const serverStockTs = Number(serverProd.stockUpdatedAt) || 0;
        const clientStockTs = Number(clientProd.stockUpdatedAt) || 0;
        if (serverStockTs > clientStockTs || getProductDeductFromTxs(serverProd, missedServerTxs) > 0) {
          return Object.assign({}, serverProd);
        }

        const mergedProd = Object.assign({}, clientProd);
        delete mergedProd._explicitStockEdit;
        // Preserve product SKU/code integrity if missing on client
        if (!mergedProd.sku && serverProd.sku) mergedProd.sku = serverProd.sku;
        if (!mergedProd.code && serverProd.code) mergedProd.code = serverProd.code;
        if (
          mergedProd.stock !== serverProd.stock ||
          mergedProd.price !== serverProd.price ||
          mergedProd.cost !== serverProd.cost ||
          mergedProd.measureType !== serverProd.measureType ||
          mergedProd.pieceWeight !== serverProd.pieceWeight ||
          mergedProd.category !== serverProd.category
        ) {
          mergedProd.stockUpdatedAt = nowMs;
        }
        return mergedProd;
      });

    // Safeguard: preserve any products present on server that client did not have (keyed strictly by ID),
    // provided they have not been deleted
    const clientProdIds = new Set(clientData.products.map(p => p.id).filter(Boolean));
    serverData.products.forEach(sp => {
      if (sp && sp.id && !clientProdIds.has(sp.id) && !deletedProducts.has(sp.id)) {
        mergedProducts.push(sp);
      }
    });

    result.products = mergedProducts.filter(p => p && p.id && !deletedProducts.has(p.id));
  } else if (Array.isArray(result.products)) {
    result.products = result.products.filter(p => p && p.id && !deletedProducts.has(p.id));
  }

  // 7. ACTIVE SHIFT CONSISTENCY:
  if (result.cashShiftLog && result.cashShiftLog.status === 'Abierto') {
    const shift = result.cashShiftLog;
    const shiftId = shift.shiftId;
    const shiftOpenedDate = shift.openedDate || (shift.openedIso ? shift.openedIso.slice(0, 10) : new Date().toISOString().slice(0, 10));

    let totalCashSales = 0;
    let totalCardSales = 0;

    result.recentTransactions.forEach(tx => {
      const st = String(tx.status || '').toLowerCase();
      if (st === 'anulado' || st === 'cancelado' || st === 'cancelled') return;
      const belongs = tx.shiftId ? (tx.shiftId === shiftId) : (!tx.closedShiftId && (tx.date && tx.date.includes(shiftOpenedDate.split('-').reverse().join('/'))));
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
      const belongs = a.shiftId ? (a.shiftId === shiftId) : (!a.closedShiftId && a.date && a.date.startsWith(shiftOpenedDate));
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
    let totalBankExpenses = 0;
    const shiftOpenedDdmmyyyy = shiftOpenedDate.split('-').reverse().join('/');
    (result.expenses || []).forEach(e => {
      // STRICT: Must match this shiftId, OR if no shiftId, must match shift openedDate and NOT belong to a closed shift
      const dateMatches = e.date && (e.date === shiftOpenedDate || e.date.startsWith(shiftOpenedDate) || e.date.includes(shiftOpenedDdmmyyyy));
      const belongs = e.shiftId ? (e.shiftId === shiftId) : (!e.closedShiftId && dateMatches);
      if (belongs) {
        const m = (e.paymentMethod || e.method || '').toLowerCase();
        const amt = Math.round(Number(e.amount) || 0);
        if (m.includes('efectivo') || m.includes('cash') || m.includes('caja') || m.includes('gaveta')) {
          totalCashExpenses += amt;
        } else {
          totalBankExpenses += amt;
        }
      }
    });

    let totalCashAbonosCompras = 0;
    let totalBankAbonosCompras = 0;
    (result.abonosCompras || []).forEach(a => {
      const dateMatches = a.date && (a.date === shiftOpenedDate || a.date.startsWith(shiftOpenedDate) || a.date.includes(shiftOpenedDdmmyyyy));
      const belongs = a.shiftId ? (a.shiftId === shiftId) : (!a.closedShiftId && dateMatches);
      if (belongs) {
        const m = (a.method || 'Efectivo').toLowerCase();
        const amt = Math.round(Number(a.amount) || 0);
        if (m.includes('efectivo') || m.includes('cash') || m.includes('caja') || m.includes('gaveta')) {
          totalCashAbonosCompras += amt;
        } else {
          totalBankAbonosCompras += amt;
        }
      }
    });

    let totalCashPurchases = 0;
    let totalBankPurchases = 0;
    (result.purchases || []).forEach(po => {
      const dateMatches = po.date && (po.date === shiftOpenedDate || po.date.startsWith(shiftOpenedDate) || po.date.includes(shiftOpenedDdmmyyyy));
      const belongs = po.shiftId ? (po.shiftId === shiftId) : (!po.closedShiftId && dateMatches);
      if (belongs) {
        // Excluir compras a crédito pendientes donde NO hubo desembolso inmediato de dinero
        const isCreditPurchase = (po.paymentStatus && po.paymentStatus !== 'Pagado Total' && po.paymentStatus !== 'Pagado') || 
                                 (po.paymentMethod && po.paymentMethod.toLowerCase().includes('crédito'));
        if (isCreditPurchase && (!po.paidAmount || Number(po.paidAmount) <= 0)) {
          return;
        }
        const amt = Math.round(Number(po.paidAmount !== undefined && po.paidAmount !== null && Number(po.paidAmount) > 0 ? po.paidAmount : po.total) || 0);
        if (amt <= 0) return;

        const m = (po.paymentMethod || 'Efectivo').toLowerCase();
        if (m.includes('efectivo') || m.includes('cash') || m.includes('caja') || m.includes('gaveta')) {
          totalCashPurchases += amt;
        } else if (!m.includes('crédito') && !m.includes('credito')) {
          totalBankPurchases += amt;
        }
      }
    });

    const consolidatedCashExpenses = totalCashExpenses + totalCashAbonosCompras + totalCashPurchases;
    const consolidatedBankExpenses = totalBankExpenses + totalBankAbonosCompras + totalBankPurchases;

    shift.cashSales = totalCashSales;
    shift.cardSales = totalCardSales;
    shift.cashExpenses = consolidatedCashExpenses;
    shift.bankExpenses = consolidatedBankExpenses;
    shift.totalExpenses = consolidatedCashExpenses + consolidatedBankExpenses;
    const opening = Number(shift.openingCash) || 0;
    shift.expectedCashInDrawer = opening + totalCashSales + totalCashAbonos - consolidatedCashExpenses;
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
    const isAdminUser = roleLower.includes('admin') || roleLower.includes('gerente') || roleLower.includes('super');
    let mergedData = data;
    if (mongoConnected) {
      const existingDoc = await DataModel.findOne({ key: storeId });
      if (existingDoc && existingDoc.content) {
        mergedData = mergeStoreState(existingDoc.content, data, isAdminUser);
      }
    } else {
      const localExisting = loadLocalDb(storeId);
      if (localExisting) {
        mergedData = mergeStoreState(localExisting, data, isAdminUser);
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
      mergedProducts: mergedData.products,
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
