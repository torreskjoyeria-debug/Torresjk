# 💎 Torres Joyería - Sistema POS & Gestión Joyera Multi-Tienda SaaS

Plataforma integral de Punto de Venta (POS), arquitectura multi-tienda aislada, control de inventario de metales preciosos (Oro 18K, 14K, Plata 925), compras por pesaje, plan separe, crédito a clientes, arqueo de caja y facturación con soporte para impresora térmica de 80mm / 58mm.

---

## ✨ Características Principales

- 🏢 **Arquitectura Multi-Tienda Aislada**: Cada sede cuenta con inventario, ventas, clientes, caja y finanzas 100% independientes, con selector dinámico y permisos por rol.
- ⚖️ **Control de Inventario por Gramaje & Pesaje Joyero**: Cálculo de stock en gramos reales (`kg`, `g`, `mg`, `oz`), costo promedio ponderado y gramaje total en tiempo real.
- 🛒 **Punto de Venta (POS)**: Búsqueda ágil por código/SKU, selector de clientes con tipos de documento (CC, CE, Pasaporte), cálculo de precio según gramaje, precio unitario manual y soporte de múltiples formas de pago.
- 📦 **Módulo de Compras**: Registro de compras de oro y metales con actualización instantánea de stock y recalculo automático del costo promedio ponderado.
- 📅 **Plan Separe & Créditos**: Gestión de abonos, seguimiento de saldos y recordatorios de pago.
- 💰 **Arqueo y Cierre de Caja**: Registro de apertura, movimientos en efectivo, transferencias, QR y cuadre ciego con detección de discrepancias.
- 🧾 **Impresión Térmica Directa**: Tickets de venta, recibos de compra y comprobantes de abono formateados para impresoras térmicas ESC/POS (80mm y 58mm).
- 🔐 **Control de Acceso Basado en Roles (RBAC)**: Perfiles diferenciados para Super Admin, Gerente, Cajero y Contador.
- ☁️ **Persistencia en MongoDB Atlas**: Sincronización en cluster MongoDB Atlas (`torreskjoyeria_pos`) con respaldo local en `db.json`.

---

## 🚀 Puesta en Marcha

### Prerrequisitos
- [Node.js](https://nodejs.org/) (versión 18 o superior)
- Conexión a Internet para MongoDB Atlas

### Instalación
```bash
# Clonar el repositorio
git clone https://github.com/torreskjoyeria-debug/Torresjk.git

# Entrar al directorio
cd Torresjk

# Instalar dependencias
npm install
```

### Ejecución
```bash
# Iniciar servidor local
npm start
```
El sistema estará accesible en `http://localhost:4000`.

---

## 🔑 Credenciales Iniciales
- **Usuario Super Admin:** `carlos@nexuspos.io` / `123456`
- **Usuario Cajero Sede Principal:** `cajeroprincipal@nexuspos.io` / `123456`
- **Usuario Cajero Sede Centro:** `cajerocentro@nexuspos.io` / `123456`

---

## 📄 Licencia
Propiedad de **Torres Joyería**. Todos los derechos reservados.
