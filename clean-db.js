const fs = require('fs');
const path = require('path');
const dns = require('dns');
const mongoose = require('mongoose');

if (!process.env.VERCEL) {
  try {
    dns.setServers(['8.8.8.8', '1.1.1.1']);
  } catch (e) {}
}

const CLIENT2_MONGO_URI = process.env.MONGO_URI || 'mongodb://torreskjoyeria_db_user:URoLcZKCyxXsc7x3@ac-e37s3f2-shard-00-00.i2bsl70.mongodb.net:27017,ac-e37s3f2-shard-00-01.i2bsl70.mongodb.net:27017,ac-e37s3f2-shard-00-02.i2bsl70.mongodb.net:27017/torreskjoyeria_pos?ssl=true&replicaSet=atlas-14ojy7-shard-0&authSource=admin&retryWrites=true&w=majority';
const CLIENT2_DB_FILE = path.join(__dirname, 'db.json');

// Triple-check that we are strictly using torreskjoyeria_pos and NOT touching charlesjoyas
if (!CLIENT2_MONGO_URI.includes('torreskjoyeria_pos') || CLIENT2_MONGO_URI.includes('charlesjoyas') || CLIENT2_DB_FILE.includes('nexus-pos-saas')) {
  console.error('ERROR CRITICO DE SEGURIDAD: Configuracion invalida o intento de conexion no autorizada. Abortando de inmediato.');
  process.exit(1);
}

const DEFAULT_STORES_LIST = [
  { id: 'store_1', name: 'Sede Principal', code: 'SP', address: 'Avenida Principal # 10 - 20, Local 101', phone: '300 123 4567', email: 'principal@nexuspos.io', color: '#0284c7' },
  { id: 'store_2', name: 'Sede Centro', code: 'SC', address: 'Calle 48 # 50 - 15, Local 102 (C.C. Centro Joyero)', phone: '310 987 6543', email: 'centro@nexuspos.io', color: '#0d9488' }
];

const baseStoreData = {
  store: {
    name: "Sede Principal",
    slogan: "Oro 18k & Plata 925",
    legalName: "Joyería Demo S.A.S - Sede Principal",
    taxId: "900123456-1",
    currency: "$",
    phone: "300 123 4567",
    email: "principal@nexuspos.io",
    address: "Avenida Principal # 10 - 20",
    addressExtra: "Local 101",
    cashier: "Administrador",
    shiftStatus: "Cerrado",
    shiftStartTime: "08:00 AM",
    cashInBox: 0,
    taxRate: 0,
    branding: {
      appName: "JOYERÍA POS",
      appBadge: "SEDE 1",
      logoUrl: "",
      primaryColor: "#0284c7",
      secondaryColor: "#0d9488",
      fontHeading: "Inter",
      fontBody: "Outfit"
    },
    metalRates: {
      oro18k: 580000,
      oro14k: 510000,
      balineria: 400000,
      plata925: 400000
    }
  },
  kpis: {
    salesToday: 0,
    salesTrend: "0%",
    transactionsToday: 0,
    txTrend: "0%",
    inventoryValue: 0,
    avgCostPerGram: 0,
    avgCostGrams: 0,
    skusCount: 0,
    totalGrams: 0,
    netMargin: "0%",
    marginTrend: "0%",
    totalCustomers: 0,
    totalSuppliers: 0,
    activeServices: 0,
    totalAssetsValue: 0
  },
  users: [
    {
      id: "USR-001",
      name: "Jojan Torres",
      email: "jojan@nexuspos.io",
      password: "admin123",
      role: "Super Admin",
      status: "Active",
      storeId: "*",
      lastLogin: "Hoy 08:00 AM",
      avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&auto=format&fit=crop&q=80",
      customPermissions: null
    },
    {
      id: "USR-002",
      name: "Cajero Sede Principal",
      email: "cajeroprincipal@nexuspos.io",
      password: "123456",
      role: "Cajero",
      status: "Active",
      storeId: "store_1",
      lastLogin: "Hoy 08:00 AM",
      avatar: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=120&auto=format&fit=crop&q=80",
      customPermissions: [
        "dashboard", "pos", "ventas", "clientes", "creditos_clientes",
        "gastos", "formas_pago", "cuadre_caja", "abonos_ventas"
      ]
    },
    {
      id: "USR-003",
      name: "Cajero Sede Centro",
      email: "cajerocentro@nexuspos.io",
      password: "123456",
      role: "Cajero",
      status: "Active",
      storeId: "store_2",
      lastLogin: "Hoy 08:00 AM",
      avatar: "https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?w=120&auto=format&fit=crop&q=80",
      customPermissions: [
        "dashboard", "pos", "ventas", "clientes", "creditos_clientes",
        "gastos", "formas_pago", "cuadre_caja", "abonos_ventas"
      ]
    }
  ],
  customers: [],
  suppliers: [],
  perfiles: [
    {
      id: "PRF-01",
      name: "Super Admin",
      permissions: "Acceso total sin restricciones: Gestión Global, Sedes, Usuarios, Ajustes, Inventario, Finanzas y POS",
      usersCount: 1,
      badgeColor: "#F59E0B",
      allowedModules: ["*"]
    },
    {
      id: "PRF-03",
      name: "Cajero",
      permissions: "Ventas en POS, Cobros, Apertura y Cierre de Caja Chica",
      usersCount: 2,
      badgeColor: "#10B981",
      allowedModules: ["pos", "clientes", "cuadre_caja", "ventas", "abonos_ventas", "abonos_compras"]
    }
  ],
  expenses: [],
  paymentMethods: [
    { id: "PM-01", name: "Efectivo", icon: "cash", fee: "0%", active: true },
    { id: "PM-02", name: "Tarjeta Débito/Crédito", icon: "card", fee: "0.8%", active: true },
    { id: "PM-03", name: "Transferencia Bancaria", icon: "bank", fee: "0%", active: true },
    { id: "PM-04", name: "Crédito Cliente", icon: "credit", fee: "0%", active: true },
    { id: "PM-15", name: "Plan Separe", icon: "calendar", fee: "0%", active: true }
  ],
  purchases: [],
  customerCredits: [],
  supplierCredits: [],
  services: [],
  categories: [
    { id: "oro18k", name: "Oro 18K Italiano & Ley", itemsCount: 0, color: "#F59E0B", availableGrams: 0, cost: 444000.00 },
    { id: "plata925", name: "Plata 925 Fina", itemsCount: 0, color: "#94A3B8", availableGrams: 0, cost: 28000.00 },
    { id: "diamantes", name: "Piedras Preciosas & Dijes", itemsCount: 0, color: "#6366F1", availableGrams: 0, cost: 850000.00 },
    { id: "relojes", name: "Relojería de Lujo", itemsCount: 0, color: "#10B981", availableGrams: 0, cost: 1200000.00 }
  ],
  products: [],
  assets: [],
  cashShiftLog: {
    shiftId: "TURNO-001",
    openedAt: "08:00 AM",
    openingCash: 0,
    cashSales: 0,
    cardSales: 0,
    qrSales: 0,
    cashExpenses: 0,
    expectedCashInDrawer: 0,
    actualCashInDrawer: 0,
    discrepancy: 0,
    status: "Cerrado"
  },
  cashShiftsHistory: [],
  abonosVentas: [],
  abonosCompras: [],
  balanceSheet: {
    assetsCurrent: 0,
    assetsFixed: 0,
    totalAssets: 0,
    liabilitiesShort: 0,
    liabilitiesLong: 0,
    totalLiabilities: 0,
    netEquity: 0
  },
  stockRadarData: {
    categories: ["Oro 18K Italiano & Ley", "Plata 925 Fina", "Piedras Preciosas & Dijes", "Relojería de Lujo"],
    turnover: [0, 0, 0, 0],
    stockLevel: [0, 0, 0, 0],
    profitability: [0, 0, 0, 0],
    stockRisk: [0, 0, 0, 0]
  },
  recentTransactions: [],
  sales: [],
  financialLedger: [],
  chartData: {
    weeklySales: {
      labels: ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom", "Hoy"],
      income: [0, 0, 0, 0, 0, 0, 0, 0],
      expenses: [0, 0, 0, 0, 0, 0, 0, 0]
    },
    categorySales: {
      labels: ["Oro 18K", "Plata 925", "Diamantes", "Relojes"],
      data: [0, 0, 0, 0]
    },
    topProducts: [],
    peakHours: {
      labels: ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00"],
      transactions: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    }
  },
  updatedAt: new Date().toISOString()
};

function createStore2Data(base) {
  const s2 = JSON.parse(JSON.stringify(base));
  s2.store.name = "Sede Centro";
  s2.store.legalName = "Joyería Demo S.A.S - Sede Centro";
  s2.store.taxId = "900123456-2";
  s2.store.phone = "310 987 6543";
  s2.store.email = "centro@nexuspos.io";
  s2.store.address = "Calle 48 # 50 - 15";
  s2.store.addressExtra = "Local 102 (C.C. Centro Joyero)";
  s2.store.branding.appBadge = "SEDE 2";
  s2.store.branding.primaryColor = "#0d9488";
  s2.store.branding.secondaryColor = "#0284c7";
  return s2;
}

const multiDbPayload = {
  storesList: DEFAULT_STORES_LIST,
  activeStoreId: 'store_1',
  stores: {
    store_1: baseStoreData,
    store_2: createStore2Data(baseStoreData)
  },
  updatedAt: new Date().toISOString()
};

async function run() {
  console.log('[Clean Script] 1. Escribiendo multi-tienda limpio en:', CLIENT2_DB_FILE);
  fs.writeFileSync(CLIENT2_DB_FILE, JSON.stringify(multiDbPayload, null, 2), 'utf8');
  console.log('[Clean Script] Local db.json multi-tienda guardado exitosamente.');

  console.log('[Clean Script] 2. Conectando a MongoDB Atlas base de datos aislada: torreskjoyeria_pos');
  await mongoose.connect(CLIENT2_MONGO_URI);
  console.log('[Clean Script] Conectado a MongoDB Atlas en torreskjoyeria_pos');

  const DataSchema = new mongoose.Schema({
    key: { type: String, default: 'main_store', unique: true },
    content: mongoose.Schema.Types.Mixed,
    updatedAt: { type: Date, default: Date.now }
  });
  const DataModel = mongoose.model('NexusData', DataSchema);

  // Guardar store_1, store_2 y manifest
  await DataModel.findOneAndUpdate(
    { key: 'stores_manifest' },
    { content: { storesList: DEFAULT_STORES_LIST, activeStoreId: 'store_1' }, updatedAt: new Date() },
    { upsert: true, new: true }
  );

  await DataModel.findOneAndUpdate(
    { key: 'store_1' },
    { content: multiDbPayload.stores.store_1, updatedAt: new Date() },
    { upsert: true, new: true }
  );

  await DataModel.findOneAndUpdate(
    { key: 'store_2' },
    { content: multiDbPayload.stores.store_2, updatedAt: new Date() },
    { upsert: true, new: true }
  );

  // Espejo retrocompatible para main_store
  await DataModel.findOneAndUpdate(
    { key: 'main_store' },
    { content: multiDbPayload.stores.store_1, updatedAt: new Date() },
    { upsert: true, new: true }
  );

  console.log('[Clean Script] Documentos store_1, store_2, stores_manifest y main_store guardados exitosamente!');
  await mongoose.disconnect();
  console.log('[Clean Script] Proceso multi-tienda completado al 100%.');
}

run().catch(err => {
  console.error('[Clean Script] Error:', err);
  process.exit(1);
});

