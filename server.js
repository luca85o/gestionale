const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const pdf = require("pdf-parse");
const { spawnSync } = require("child_process");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "data", "db.json");
const upload = multer({ dest: path.join(__dirname, "uploads") });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));

function readDB() {
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function writeDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

function nextId(items) {
  return items.length ? Math.max(...items.map(x => Number(x.id) || 0)) + 1 : Date.now();
}

function textIncludes(v, q) {
  return String(v || "").toLowerCase().includes(q);
}

function normalizeText(s) {
  return String(s || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAliasText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[().,#\-_/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSizeToken(text) {
  const t = normalizeAliasText(text).replace(/\s/g, "");
  const m = t.match(/(\d{2,3})x(\d{2,3})/);
  return m ? `${m[1]}x${m[2]}` : "";
}

function isCimminoText(text) {
  const t = String(text || "").toLowerCase();
  return t.includes("cimmino") || t.includes("conferma d'ordine") || t.includes("conferma d ordine");
}

function shouldIgnoreDescription(desc) {
  const t = String(desc || "").toLowerCase();
  return (
    t.includes("trasporto") ||
    t.includes("spedizione") ||
    t.includes("sconto") ||
    t.includes("concessovi") ||
    t.includes("quota fissa")
  );
}

function parseCimminoRows(text) {
  const rows = [];
  const lines = String(text || "")
    .split(/\r?\n/)
    .map(x => normalizeText(x))
    .filter(Boolean);

  for (const line of lines) {
    const m = line.match(
      /^([A-Z0-9@]{5,8})\s+(.+?)\s+\b(NR|PZ|CT|CF)\b\s+(-?\d+(?:,\d+)?)\s+(-?\d+(?:,\d+)?)\s+(-?\d+(?:,\d+)?)$/i
    );

    if (m) {
      const code = m[1].trim();
      const desc = normalizeText(m[2]);
      const qty = Number(String(m[4]).replace(",", "."));

      rows.push({
        ean: "",
        supplierCode: code,
        description: desc,
        qty,
        action: shouldIgnoreDescription(desc) || code.startsWith("@") || qty <= 0 ? "ignore" : "map",
        createAlias: !(shouldIgnoreDescription(desc) || code.startsWith("@") || qty <= 0),
        fulfillmentSource: "warehouse"
      });
      continue;
    }

    if (/quota fissa di trasporto|sconto concessovi/i.test(line)) {
      rows.push({
        ean: "",
        supplierCode: "",
        description: line,
        qty: 1,
        action: "ignore",
        createAlias: false,
        fulfillmentSource: "supplier"
      });
    }
  }

  return rows.filter(r => {
    const d = String(r.description || "").toLowerCase();
    return !(d.includes("totale imponibile") || d.includes("totale iva") || d.includes("totale documento"));
  });
}

function lowStock(db) {
  return (db.stocks || []).filter(s => Number(s.qty) <= Number(s.minQty || 0));
}

function productName(db, id) {
  return (db.products || []).find(x => Number(x.id) === Number(id))?.name || "";
}

function supplierName(db, id) {
  return (db.suppliers || []).find(x => Number(x.id) === Number(id))?.name || "";
}

function clientName(db, id) {
  return (db.clients || []).find(x => Number(x.id) === Number(id))?.name || "";
}

function warehouseName(db, id) {
  return (db.warehouses || []).find(x => Number(x.id) === Number(id))?.name || "";
}

function partnerName(db, type, id) {
  return type === "supplier" ? supplierName(db, id) : clientName(db, id);
}

function detectSupplierIdFromText(db, text) {
  const t = String(text || "").toLowerCase();
  if (t.includes("cimmino")) {
    return ((db.suppliers || []).find(s => /cimmino/i.test(s.name)) || {}).id || null;
  }
  return null;
}

function guessProductForRow(db, row) {
  const aliasType = "supplier";
  const code = String(row.supplierCode || "").trim().toLowerCase();
  const desc = normalizeAliasText(row.description || "");
  const size = extractSizeToken(row.description || "");
  const aliases = (db.aliases || []).filter(a => String(a.aliasType || "supplier") === aliasType);

  if (code) {
    const byCode = aliases.find(a => String(a.supplierCode || "").trim().toLowerCase() === code);
    if (byCode) return byCode.productId;
  }

  if (desc) {
    const byDesc = aliases.find(a => normalizeAliasText(a.supplierDescription || "") === desc);
    if (byDesc) return byDesc.productId;
  }

  const p = (db.products || []).find(p => {
    const pt = normalizeAliasText(`${p.name || ""} ${p.sku || ""} ${p.category || ""} ${p.size || ""}`);
    const psize = extractSizeToken(`${p.name || ""} ${p.size || ""}`);
    const sameSize = !size || !psize || psize === size;
    return sameSize && pt && (pt.includes(desc) || desc.includes(pt));
  });

  return p ? p.id : "";
}

async function getUsersFromPostgres() {
  const result = await pool.query(`
    select
      u.id,
      u.name,
      u.email,
      u.role_key,
      r.name as role
    from users u
    left join roles r on r.key = u.role_key
    order by u.id desc
  `);

  return result.rows.map(u => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role || "Solo lettura",
    roleKey: u.role_key || "viewer"
  }));
}

async function getSuppliersFromDb() {
  const { rows } = await pool.query(`
    select
      id,
      name,
      vat,
      email,
      phone,
      contact,
      notes
    from suppliers
    order by id desc
  `);
  return rows;
}

async function getClientsFromDb() {
  const { rows } = await pool.query(`
    select
      id,
      name,
      vat,
      email,
      phone,
      contact,
      notes
    from clients
    order by id desc
  `);
  return rows;
}

async function getWarehousesFromDb() {
  const { rows } = await pool.query(`
    select
      id,
      name,
      city,
      address
    from warehouses
    order by id desc
  `);
  return rows;
}

async function getProductsFromDb() {
  const { rows } = await pool.query(`
    select
      id,
      name,
      sku,
      category,
      color,
      size,
      ean,
      notes,
      purchase_price_net as "purchasePriceNet",
      purchase_price_gross as "purchasePriceGross",
      sale_price_net as "salePriceNet",
      sale_price_gross as "salePriceGross",
      vat_rate as "vatRate",
      supplier_pack_qty as "supplierPackQty"
    from products
    order by id desc
  `);
  return rows;
}

async function getStocksFromDb() {
  const { rows } = await pool.query(`
    select
      id,
      warehouse_id as "warehouseId",
      product_id as "productId",
      qty,
      min_qty as "minQty"
    from stocks
    order by id desc
  `);
  return rows;
}

async function getMovementsFromDb() {
  const { rows } = await pool.query(`
    select
      id,
      type,
      date,
      warehouse_id as "warehouseId",
      destination_warehouse_id as "destinationWarehouseId",
      partner_type as "partnerType",
      partner_id as "partnerId",
      order_no as "orderNo",
      invoice_no as "invoiceNo",
      ddt_no as "ddtNo",
      notes
    from movements
    order by id desc
  `);

  const movements = [];
  for (const m of rows) {
    const rr = await pool.query(`
      select
        product_id as "productId",
        qty,
        fulfillment_source as "fulfillmentSource",
        stock_impact as "stockImpact"
      from movement_rows
      where movement_id = $1
      order by id asc
    `, [m.id]);

    movements.push({
      ...m,
      rows: rr.rows
    });
  }

  return movements;
}

async function buildDbLike() {
  const legacy = readDB();

  const [
    users,
    suppliers,
    clients,
    warehouses,
    products,
    stocks,
    movements
  ] = await Promise.all([
    getUsersFromPostgres(),
    getSuppliersFromDb(),
    getClientsFromDb(),
    getWarehousesFromDb(),
    getProductsFromDb(),
    getStocksFromDb(),
    getMovementsFromDb()
  ]);

  return {
    users,
    suppliers,
    clients,
    warehouses,
    products,
    stocks,
    movements,
    aliases: legacy.aliases || [],
    imports: legacy.imports || [],
    roles: legacy.roles || []
  };
}

function searchAll(db, q) {
  q = String(q || "").trim().toLowerCase();

  if (!q) {
    return {
      products: [],
      suppliers: [],
      clients: [],
      warehouses: [],
      stocks: [],
      movements: [],
      aliases: [],
      documents: []
    };
  }

  return {
    products: (db.products || []).filter(x =>
      [
        x.name,
        x.sku,
        x.category,
        x.color,
        x.size,
        x.ean,
        x.notes,
        x.purchasePriceNet,
        x.purchasePriceGross,
        x.salePriceNet,
        x.salePriceGross,
        x.vatRate,
        x.supplierPackQty
      ].some(v => textIncludes(v, q))
    ),
    suppliers: (db.suppliers || []).filter(x =>
      [x.name, x.vat, x.email, x.phone, x.contact, x.notes].some(v => textIncludes(v, q))
    ),
    clients: (db.clients || []).filter(x =>
      [x.name, x.vat, x.email, x.phone, x.contact, x.notes].some(v => textIncludes(v, q))
    ),
    warehouses: (db.warehouses || []).filter(x =>
      [x.name, x.city, x.address].some(v => textIncludes(v, q))
    ),
    stocks: (db.stocks || []).filter(x =>
      [productName(db, x.productId), warehouseName(db, x.warehouseId), x.qty, x.minQty].some(v => textIncludes(v, q))
    ),
    movements: (db.movements || []).filter(x =>
      [
        x.type,
        x.date,
        partnerName(db, x.partnerType, x.partnerId),
        warehouseName(db, x.warehouseId),
        x.orderNo,
        x.invoiceNo,
        x.ddtNo,
        x.notes,
        (x.rows || []).map(r => `${productName(db, r.productId)} ${r.qty} ${r.fulfillmentSource}`).join(" ")
      ].some(v => textIncludes(v, q))
    ),
    aliases: (db.aliases || []).filter(x =>
      [
        x.aliasType,
        supplierName(db, x.supplierId),
        x.supplierCode,
        x.ean,
        x.supplierDescription,
        productName(db, x.productId)
      ].some(v => textIncludes(v, q))
    ),
    documents: (db.imports || []).filter(x =>
      [
        x.documentDirection,
        x.documentType,
        x.documentNo,
        x.documentDate,
        x.originalFileName,
        x.status,
        supplierName(db, x.supplierId),
        clientName(db, x.clientId)
      ].some(v => textIncludes(v, q))
    )
  };
}

async function ensureStockDb(warehouseId, productId) {
  const existing = await pool.query(`
    select
      id,
      warehouse_id as "warehouseId",
      product_id as "productId",
      qty,
      min_qty as "minQty"
    from stocks
    where warehouse_id = $1 and product_id = $2
    limit 1
  `, [warehouseId, productId]);

  if (existing.rows[0]) return existing.rows[0];

  const inserted = await pool.query(`
    insert into stocks (warehouse_id, product_id, qty, min_qty)
    values ($1, $2, 0, 0)
    returning
      id,
      warehouse_id as "warehouseId",
      product_id as "productId",
      qty,
      min_qty as "minQty"
  `, [warehouseId, productId]);

  return inserted.rows[0];
}

async function applyMovementDb(movement) {
  for (const row of movement.rows || []) {
    if (row.fulfillmentSource !== "warehouse") continue;

    if (movement.type === "carico") {
      await ensureStockDb(movement.warehouseId, row.productId);
      await pool.query(`
        update stocks
        set qty = qty + $1
        where warehouse_id = $2 and product_id = $3
      `, [Number(row.qty), movement.warehouseId, row.productId]);
    }

    if (movement.type === "scarico") {
      await ensureStockDb(movement.warehouseId, row.productId);
      await pool.query(`
        update stocks
        set qty = qty - $1
        where warehouse_id = $2 and product_id = $3
      `, [Number(row.qty), movement.warehouseId, row.productId]);
    }

    if (movement.type === "trasferimento") {
      await ensureStockDb(movement.warehouseId, row.productId);
      await ensureStockDb(movement.destinationWarehouseId, row.productId);

      await pool.query(`
        update stocks
        set qty = qty - $1
        where warehouse_id = $2 and product_id = $3
      `, [Number(row.qty), movement.warehouseId, row.productId]);

      await pool.query(`
        update stocks
        set qty = qty + $1
        where warehouse_id = $2 and product_id = $3
      `, [Number(row.qty), movement.destinationWarehouseId, row.productId]);
    }
  }
}

async function parsePdfRows(filePath, direction) {
  try {
    const buffer = fs.readFileSync(filePath);
    const parsed = await pdf(buffer);
    const text = parsed.text || "";
    const db = await buildDbLike();

    if (direction !== "supplier") {
      return { rows: [], detectedSupplierId: null, parser: "disabled-client" };
    }

    const detectedSupplierId = detectSupplierIdFromText(db, text);

    let rows = parseCimminoRows(text);
    if (rows.length) {
      return { rows, detectedSupplierId, parser: "cimmino-text" };
    }

    if (isCimminoText(text) || (filePath || "").toLowerCase().includes("gala")) {
      try {
        const ocr = spawnSync("python3", [path.join(__dirname, "ocr_parser.py"), filePath], {
          encoding: "utf8",
          timeout: 30000
        });

        if (ocr.status === 0 && ocr.stdout) {
          const parsedOcr = JSON.parse(ocr.stdout);
          const ocrRows = parsedOcr.rows || [];
          if (ocrRows.length) {
            return { rows: ocrRows, detectedSupplierId, parser: "cimmino-ocr" };
          }
        }
      } catch (err) {}

      return { rows: [], detectedSupplierId, parser: "cimmino-no-rows" };
    }

    return { rows: [], detectedSupplierId, parser: "unsupported" };
  } catch (err) {
    return { rows: [], detectedSupplierId: null, parser: "error" };
  }
}

app.get("/api/bootstrap", async (req, res) => {
  try {
    const db = await buildDbLike();

    res.json({
      ok: true,
      ...db,
      lowStock: lowStock(db)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: "Errore bootstrap", error: e.message });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const db = await buildDbLike();
    res.json(searchAll(db, req.query.q || ""));
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: "Errore ricerca", error: e.message });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    const result = await pool.query(`
      select
        u.id,
        u.name,
        u.email,
        u.password_hash,
        u.role_key,
        r.name as role
      from users u
      left join roles r on r.key = u.role_key
      where lower(u.email) = lower($1)
      limit 1
    `, [String(email || "")]);

    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ ok: false, message: "Credenziali non valide" });
    }

    const match = await bcrypt.compare(String(password || ""), user.password_hash);

    if (!match) {
      return res.status(401).json({ ok: false, message: "Credenziali non valide" });
    }

    res.json({
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role || "Solo lettura",
        roleKey: user.role_key || "viewer"
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Errore server", error: err.message });
  }
});

app.post("/api/register", async (req, res) => {
  try {
    const { email, password, name, roleKey } = req.body || {};
    const hash = await bcrypt.hash(String(password || ""), 10);

    const result = await pool.query(`
      insert into users(name, email, password_hash, role_key)
      values($1, $2, $3, $4)
      returning id, name, email, role_key
    `, [
      String(name || ""),
      String(email || ""),
      hash,
      String(roleKey || "viewer")
    ]);

    const user = result.rows[0];

    res.json({
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        roleKey: user.role_key
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Errore registrazione", error: err.message });
  }
});

app.get("/api/users", async (req, res) => {
  try {
    const users = await getUsersFromPostgres();
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Errore utenti", error: err.message });
  }
});

app.post("/api/users", async (req, res) => {
  try {
    const body = req.body || {};
    const password = String(body.password || "demo123");
    const hash = await bcrypt.hash(password, 10);

    const result = await pool.query(`
      insert into users(name, email, password_hash, role_key)
      values($1, $2, $3, $4)
      returning id, name, email, role_key
    `, [
      String(body.name || ""),
      String(body.email || ""),
      hash,
      String(body.roleKey || "viewer")
    ]);

    const user = result.rows[0];

    const roleResult = await pool.query(
      `select name from roles where key = $1 limit 1`,
      [user.role_key]
    );

    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      roleKey: user.role_key,
      role: roleResult.rows[0]?.name || "Solo lettura"
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Errore creazione utente", error: err.message });
  }
});

app.get("/api/suppliers", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    const rows = await getSuppliersFromDb();
    const list = !q ? rows : rows.filter(x =>
      [x.name, x.vat, x.email, x.phone, x.contact, x.notes].some(v => textIncludes(v, q))
    );
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Errore fornitori", error: err.message });
  }
});

app.post("/api/suppliers", async (req, res) => {
  try {
    const b = req.body || {};
    const result = await pool.query(`
      insert into suppliers(name, vat, email, phone, contact, notes)
      values($1,$2,$3,$4,$5,$6)
      returning id, name, vat, email, phone, contact, notes
    `, [
      String(b.name || ""),
      String(b.vat || ""),
      String(b.email || ""),
      String(b.phone || ""),
      String(b.contact || ""),
      String(b.notes || "")
    ]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Errore creazione fornitore", error: err.message });
  }
});

app.get("/api/clients", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    const rows = await getClientsFromDb();
    const list = !q ? rows : rows.filter(x =>
      [x.name, x.vat, x.email, x.phone, x.contact, x.notes].some(v => textIncludes(v, q))
    );
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Errore clienti", error: err.message });
  }
});

app.post("/api/clients", async (req, res) => {
  try {
    const b = req.body || {};
    const result = await pool.query(`
      insert into clients(name, vat, email, phone, contact, notes)
      values($1,$2,$3,$4,$5,$6)
      returning id, name, vat, email, phone, contact, notes
    `, [
      String(b.name || ""),
      String(b.vat || ""),
      String(b.email || ""),
      String(b.phone || ""),
      String(b.contact || ""),
      String(b.notes || "")
    ]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Errore creazione cliente", error: err.message });
  }
});

app.get("/api/warehouses", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    const rows = await getWarehousesFromDb();
    const list = !q ? rows : rows.filter(x =>
      [x.name, x.city, x.address].some(v => textIncludes(v, q))
    );
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Errore magazzini", error: err.message });
  }
});

app.post("/api/warehouses", async (req, res) => {
  try {
    const b = req.body || {};
    const result = await pool.query(`
      insert into warehouses(name, city, address)
      values($1,$2,$3)
      returning id, name, city, address
    `, [
      String(b.name || ""),
      String(b.city || ""),
      String(b.address || "")
    ]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Errore creazione magazzino", error: err.message });
  }
});

app.get("/api/products", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    const rows = await getProductsFromDb();
    const list = !q ? rows : rows.filter(x =>
      [
        x.name,
        x.sku,
        x.category,
        x.color,
        x.size,
        x.ean,
        x.notes,
        x.purchasePriceNet,
        x.purchasePriceGross,
        x.salePriceNet,
        x.salePriceGross,
        x.vatRate,
        x.supplierPackQty
      ].some(v => textIncludes(v, q))
    );
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Errore prodotti", error: err.message });
  }
});

app.post("/api/products", async (req, res) => {
  try {
    const b = req.body || {};
    const result = await pool.query(`
      insert into products(
        name, sku, category, color, size, ean, notes,
        purchase_price_net, purchase_price_gross,
        sale_price_net, sale_price_gross,
        vat_rate, supplier_pack_qty
      )
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      returning
        id,
        name,
        sku,
        category,
        color,
        size,
        ean,
        notes,
        purchase_price_net as "purchasePriceNet",
        purchase_price_gross as "purchasePriceGross",
        sale_price_net as "salePriceNet",
        sale_price_gross as "salePriceGross",
        vat_rate as "vatRate",
        supplier_pack_qty as "supplierPackQty"
    `, [
      String(b.name || ""),
      String(b.sku || ""),
      String(b.category || ""),
      String(b.color || ""),
      String(b.size || ""),
      String(b.ean || ""),
      String(b.notes || ""),
      b.purchasePriceNet === "" || b.purchasePriceNet == null ? null : Number(b.purchasePriceNet),
      b.purchasePriceGross === "" || b.purchasePriceGross == null ? null : Number(b.purchasePriceGross),
      b.salePriceNet === "" || b.salePriceNet == null ? null : Number(b.salePriceNet),
      b.salePriceGross === "" || b.salePriceGross == null ? null : Number(b.salePriceGross),
      b.vatRate === "" || b.vatRate == null ? null : Number(b.vatRate),
      b.supplierPackQty === "" || b.supplierPackQty == null ? null : Number(b.supplierPackQty)
    ]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Errore creazione prodotto", error: err.message });
  }
});

app.put("/api/products/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};

    const result = await pool.query(`
      update products
      set
        name = $1,
        sku = $2,
        category = $3,
        color = $4,
        size = $5,
        notes = $6,
        purchase_price_net = $7,
        purchase_price_gross = $8,
        sale_price_net = $9,
        sale_price_gross = $10,
        vat_rate = $11
      where id = $12
      returning
        id,
        name,
        sku,
        category,
        color,
        size,
        notes,
        ean,
        purchase_price_net as "purchasePriceNet",
        purchase_price_gross as "purchasePriceGross",
        sale_price_net as "salePriceNet",
        sale_price_gross as "salePriceGross",
        vat_rate as "vatRate",
        supplier_pack_qty as "supplierPackQty"
    `, [
      String(b.name || ""),
      String(b.sku || ""),
      String(b.category || ""),
      String(b.color || ""),
      String(b.size || ""),
      String(b.notes || ""),
      b.purchasePriceNet === "" || b.purchasePriceNet == null ? null : Number(b.purchasePriceNet),
      b.purchasePriceGross === "" || b.purchasePriceGross == null ? null : Number(b.purchasePriceGross),
      b.salePriceNet === "" || b.salePriceNet == null ? null : Number(b.salePriceNet),
      b.salePriceGross === "" || b.salePriceGross == null ? null : Number(b.salePriceGross),
      b.vatRate === "" || b.vatRate == null ? null : Number(b.vatRate),
      id
    ]);

    if (!result.rows[0]) {
      return res.status(404).json({ ok: false, message: "Prodotto non trovato" });
    }

    res.json({ ok: true, product: result.rows[0], message: "Prodotto modificato con successo" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Errore aggiornamento prodotto", error: err.message });
  }
});

app.delete("/api/products/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const force = String(req.query.force || "") === "1";

    const qtyResult = await pool.query(`
      select coalesce(sum(qty), 0) as total_qty
      from stocks
      where product_id = $1
    `, [id]);

    const totalQty = Number(qtyResult.rows[0]?.total_qty || 0);

    if (totalQty > 0 && !force) {
      return res.status(409).json({
        ok: false,
        needsConfirm: true,
        totalQty,
        message: `Il prodotto ha giacenze maggiori di zero (${totalQty}). Confermi l'eliminazione?`
      });
    }

    await pool.query(`delete from movement_rows where product_id = $1`, [id]);
    await pool.query(`delete from stocks where product_id = $1`, [id]);

    const deleted = await pool.query(`
      delete from products
      where id = $1
      returning id, name
    `, [id]);

    if (!deleted.rows[0]) {
      return res.status(404).json({ ok: false, message: "Prodotto non trovato" });
    }

    // pulizia alias nel vecchio db.json
    try {
      const legacy = readDB();
      legacy.aliases = (legacy.aliases || []).filter(a => Number(a.productId) !== id);
      writeDB(legacy);
    } catch (_) {}

    res.json({
      ok: true,
      message: "Prodotto eliminato con successo",
      deleted: deleted.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Errore eliminazione prodotto", error: err.message });
  }
});

app.get("/api/aliases", (req, res) => {
  const db = readDB();
  const q = String(req.query.q || "").trim().toLowerCase();
  const list = !q ? (db.aliases || []) : (db.aliases || []).filter(x =>
    Object.values(x).some(v => textIncludes(v, q))
  );
  res.json(list);
});

app.post("/api/aliases", (req, res) => {
  const db = readDB();
  db.aliases = db.aliases || [];
  const item = { id: nextId(db.aliases), ...req.body };
  db.aliases.push(item);
  writeDB(db);
  res.json(item);
});

app.get("/api/stocks", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    const db = await buildDbLike();
    const list = !q ? db.stocks : db.stocks.filter(x =>
      [productName(db, x.productId), warehouseName(db, x.warehouseId), x.qty, x.minQty].some(v => textIncludes(v, q))
    );
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Errore giacenze", error: err.message });
  }
});

app.put("/api/stocks/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};

    const result = await pool.query(`
      update stocks
      set
        qty = coalesce($1, qty),
        min_qty = coalesce($2, min_qty)
      where id = $3
      returning
        id,
        warehouse_id as "warehouseId",
        product_id as "productId",
        qty,
        min_qty as "minQty"
    `, [
      body.qty === undefined ? null : Number(body.qty),
      body.minQty === undefined ? null : Number(body.minQty),
      id
    ]);

    if (!result.rows[0]) {
      return res.status(404).json({ ok: false, message: "Giacenza non trovata" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Errore aggiornamento giacenza", error: err.message });
  }
});

app.get("/api/movements", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    const db = await buildDbLike();
    const list = !q ? db.movements : db.movements.filter(x =>
      [
        x.type,
        x.date,
        partnerName(db, x.partnerType, x.partnerId),
        warehouseName(db, x.warehouseId),
        x.orderNo,
        x.invoiceNo,
        x.ddtNo,
        x.notes,
        (x.rows || []).map(r => `${productName(db, r.productId)} ${r.qty} ${r.fulfillmentSource}`).join(" ")
      ].some(v => textIncludes(v, q))
    );
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Errore movimenti", error: err.message });
  }
});

app.post("/api/movements", async (req, res) => {
  try {
    const body = req.body || {};
    const rows = (body.rows || []).map(r => ({
      productId: Number(r.productId),
      qty: Number(r.qty),
      fulfillmentSource: r.fulfillmentSource || "warehouse",
      stockImpact: r.fulfillmentSource === "warehouse"
    }));

    const inserted = await pool.query(`
      insert into movements(
        type, date, warehouse_id, destination_warehouse_id,
        partner_type, partner_id, order_no, invoice_no, ddt_no, notes
      )
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      returning
        id,
        type,
        date,
        warehouse_id as "warehouseId",
        destination_warehouse_id as "destinationWarehouseId",
        partner_type as "partnerType",
        partner_id as "partnerId",
        order_no as "orderNo",
        invoice_no as "invoiceNo",
        ddt_no as "ddtNo",
        notes
    `, [
      String(body.type || ""),
      body.date || null,
      body.warehouseId ? Number(body.warehouseId) : null,
      body.destinationWarehouseId ? Number(body.destinationWarehouseId) : null,
      body.partnerType || null,
      body.partnerId ? Number(body.partnerId) : null,
      String(body.orderNo || ""),
      String(body.invoiceNo || ""),
      String(body.ddtNo || ""),
      String(body.notes || "")
    ]);

    const movement = inserted.rows[0];

    for (const r of rows) {
      await pool.query(`
        insert into movement_rows(movement_id, product_id, qty, fulfillment_source, stock_impact)
        values($1,$2,$3,$4,$5)
      `, [
        movement.id,
        r.productId,
        r.qty,
        r.fulfillmentSource,
        Boolean(r.stockImpact)
      ]);
    }

    await applyMovementDb({
      ...movement,
      rows
    });

    res.json({
      ...movement,
      rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Errore creazione movimento", error: err.message });
  }
});

app.post("/api/migrate-json-to-db", async (req, res) => {
  try {
    const db = readDB();

    for (const s of db.suppliers || []) {
      await pool.query(`
        insert into suppliers (id, name, vat, email, phone, contact, notes)
        values ($1,$2,$3,$4,$5,$6,$7)
        on conflict (id) do update set
          name = excluded.name,
          vat = excluded.vat,
          email = excluded.email,
          phone = excluded.phone,
          contact = excluded.contact,
          notes = excluded.notes
      `, [s.id, s.name || "", s.vat || "", s.email || "", s.phone || "", s.contact || "", s.notes || ""]);
    }

    for (const c of db.clients || []) {
      await pool.query(`
        insert into clients (id, name, vat, email, phone, contact, notes)
        values ($1,$2,$3,$4,$5,$6,$7)
        on conflict (id) do update set
          name = excluded.name,
          vat = excluded.vat,
          email = excluded.email,
          phone = excluded.phone,
          contact = excluded.contact,
          notes = excluded.notes
      `, [c.id, c.name || "", c.vat || "", c.email || "", c.phone || "", c.contact || "", c.notes || ""]);
    }

    for (const w of db.warehouses || []) {
      await pool.query(`
        insert into warehouses (id, name, city, address)
        values ($1,$2,$3,$4)
        on conflict (id) do update set
          name = excluded.name,
          city = excluded.city,
          address = excluded.address
      `, [w.id, w.name || "", w.city || "", w.address || ""]);
    }

    for (const p of db.products || []) {
      await pool.query(`
        insert into products (
          id, name, sku, category, color, size, ean, notes,
          purchase_price_net, purchase_price_gross,
          sale_price_net, sale_price_gross,
          vat_rate, supplier_pack_qty
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        on conflict (id) do update set
          name = excluded.name,
          sku = excluded.sku,
          category = excluded.category,
          color = excluded.color,
          size = excluded.size,
          ean = excluded.ean,
          notes = excluded.notes,
          purchase_price_net = excluded.purchase_price_net,
          purchase_price_gross = excluded.purchase_price_gross,
          sale_price_net = excluded.sale_price_net,
          sale_price_gross = excluded.sale_price_gross,
          vat_rate = excluded.vat_rate,
          supplier_pack_qty = excluded.supplier_pack_qty
      `, [
        p.id,
        p.name || "",
        p.sku || "",
        p.category || "",
        p.color || "",
        p.size || "",
        p.ean || "",
        p.notes || "",
        p.purchasePriceNet === "" || p.purchasePriceNet == null ? null : Number(p.purchasePriceNet),
        p.purchasePriceGross === "" || p.purchasePriceGross == null ? null : Number(p.purchasePriceGross),
        p.salePriceNet === "" || p.salePriceNet == null ? null : Number(p.salePriceNet),
        p.salePriceGross === "" || p.salePriceGross == null ? null : Number(p.salePriceGross),
        p.vatRate === "" || p.vatRate == null ? null : Number(p.vatRate),
        p.supplierPackQty === "" || p.supplierPackQty == null ? null : Number(p.supplierPackQty)
      ]);
    }

    for (const s of db.stocks || []) {
      await pool.query(`
        insert into stocks (id, warehouse_id, product_id, qty, min_qty)
        values ($1,$2,$3,$4,$5)
        on conflict (warehouse_id, product_id) do update set
          qty = excluded.qty,
          min_qty = excluded.min_qty
      `, [s.id, s.warehouseId, s.productId, Number(s.qty || 0), Number(s.minQty || 0)]);
    }

    for (const m of db.movements || []) {
      await pool.query(`
        insert into movements (
          id, type, date, warehouse_id, destination_warehouse_id,
          partner_type, partner_id, order_no, invoice_no, ddt_no, notes
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        on conflict (id) do nothing
      `, [
        m.id,
        m.type || "",
        m.date || null,
        m.warehouseId || null,
        m.destinationWarehouseId || null,
        m.partnerType || null,
        m.partnerId || null,
        m.orderNo || "",
        m.invoiceNo || "",
        m.ddtNo || "",
        m.notes || ""
      ]);

      for (const r of m.rows || []) {
        await pool.query(`
          insert into movement_rows (
            movement_id, product_id, qty, fulfillment_source, stock_impact
          )
          values ($1,$2,$3,$4,$5)
        `, [
          m.id,
          r.productId,
          Number(r.qty || 0),
          r.fulfillmentSource || "warehouse",
          Boolean(r.stockImpact)
        ]);
      }
    }

    res.json({ ok: true, message: "Migrazione completata" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Errore migrazione", error: err.message });
  }
});

app.get("/api/imports", async (req, res) => {
  try {
    const db = await buildDbLike();
    const q = String(req.query.q || "").trim().toLowerCase();
    const list = !q ? db.imports : db.imports.filter(x =>
      [x.documentDirection, x.documentType, x.documentNo, x.documentDate, x.originalFileName, x.status, supplierName(db, x.supplierId), clientName(db, x.clientId)].some(v =>
        textIncludes(v, q)
      )
    );
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Errore imports", error: err.message });
  }
});

app.post("/api/imports/upload", upload.single("document"), async (req, res) => {
  try {
    const legacy = readDB();
    const db = await buildDbLike();
    const body = req.body || {};
    const direction = body.documentDirection || "supplier";

    let parserResult = { rows: [], detectedSupplierId: null, parser: "none" };
    if (req.file) parserResult = await parsePdfRows(req.file.path, direction);

    const finalSupplierId = body.supplierId ? Number(body.supplierId) : parserResult.detectedSupplierId || null;

    const importDoc = {
      id: nextId(legacy.imports || []),
      documentDirection: direction,
      supplierId: finalSupplierId,
      clientId: body.clientId ? Number(body.clientId) : null,
      documentType: body.documentType || "fattura",
      documentNo: body.documentNo || "",
      documentDate: body.documentDate || "",
      warehouseId: body.warehouseId ? Number(body.warehouseId) : null,
      originalFileName: req.file ? req.file.originalname : "",
      storedFile: req.file ? `/uploads/${req.file.filename}` : "",
      rows: [],
      createdAt: new Date().toISOString(),
      status: "uploaded"
    };

    const parsedRows = (parserResult.rows || []).map(row => ({
      ...row,
      productId: row.productId || guessProductForRow(db, row)
    }));

    importDoc.rows = parsedRows;
    legacy.imports = legacy.imports || [];
    legacy.imports.unshift(importDoc);
    writeDB(legacy);

    res.json({
      ...importDoc,
      parsedRows,
      detectedSupplierId: finalSupplierId,
      parser: parserResult.parser
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Errore upload import", error: err.message });
  }
});

app.post("/api/imports/:id/rows", (req, res) => {
  const db = readDB();
  const imp = (db.imports || []).find(x => Number(x.id) === Number(req.params.id));
  if (!imp) return res.status(404).json({ ok: false, message: "Import non trovato" });
  imp.rows = req.body.rows || [];
  imp.status = "mapped";
  writeDB(db);
  res.json(imp);
});

app.post("/api/imports/:id/confirm", async (req, res) => {
  try {
    const legacy = readDB();
    const db = await buildDbLike();
    const imp = (legacy.imports || []).find(x => Number(x.id) === Number(req.params.id));

    if (!imp) {
      return res.status(404).json({ ok: false, message: "Import non trovato" });
    }

    const rows = (imp.rows || [])
      .filter(r => r.action !== "ignore" && r.productId)
      .map(r => ({
        productId: Number(r.productId),
        qty: Number(r.qty),
        fulfillmentSource: r.fulfillmentSource || "warehouse",
        stockImpact: (r.fulfillmentSource || "warehouse") === "warehouse"
      }));

    const inserted = await pool.query(`
      insert into movements(
        type, date, warehouse_id, destination_warehouse_id,
        partner_type, partner_id, order_no, invoice_no, ddt_no, notes
      )
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      returning
        id,
        type,
        date,
        warehouse_id as "warehouseId",
        destination_warehouse_id as "destinationWarehouseId",
        partner_type as "partnerType",
        partner_id as "partnerId",
        order_no as "orderNo",
        invoice_no as "invoiceNo",
        ddt_no as "ddtNo",
        notes
    `, [
      imp.documentDirection === "supplier" ? "carico" : "scarico",
      imp.documentDate || new Date().toISOString().slice(0, 10),
      Number(imp.warehouseId || 301),
      null,
      imp.documentDirection === "supplier" ? "supplier" : "client",
      Number(imp.documentDirection === "supplier" ? imp.supplierId : imp.clientId),
      "",
      imp.documentType === "fattura" ? imp.documentNo : "",
      imp.documentType === "ddt" ? imp.documentNo : "",
      `Import documento ${imp.documentDirection} ${imp.documentType} ${imp.documentNo}`.trim()
    ]);

    const movement = inserted.rows[0];

    for (const r of rows) {
      await pool.query(`
        insert into movement_rows(movement_id, product_id, qty, fulfillment_source, stock_impact)
        values($1,$2,$3,$4,$5)
      `, [
        movement.id,
        r.productId,
        r.qty,
        r.fulfillmentSource,
        Boolean(r.stockImpact)
      ]);
    }

    await applyMovementDb({
      ...movement,
      rows
    });

    for (const row of imp.rows || []) {
      if (row.productId && row.createAlias && (row.supplierCode || row.ean || row.description)) {
        const aliasType = imp.documentDirection === "supplier" ? "supplier" : "sale";
        const already = (legacy.aliases || []).find(
          a =>
            String(a.aliasType || "supplier") === aliasType &&
            String(a.supplierCode || "") === String(row.supplierCode || "") &&
            String(a.ean || "") === String(row.ean || "") &&
            Number(a.productId) === Number(row.productId)
        );

        if (!already) {
          legacy.aliases = legacy.aliases || [];
          legacy.aliases.push({
            id: nextId(legacy.aliases),
            supplierId: imp.documentDirection === "supplier" ? Number(imp.supplierId) : "",
            supplierCode: row.supplierCode || "",
            ean: row.ean || "",
            supplierDescription: row.description || "",
            productId: Number(row.productId),
            aliasType
          });
        }
      }
    }

    imp.confirmedMovementId = movement.id;
    imp.status = "confirmed";
    writeDB(legacy);

    res.json({ ok: true, movement, importDoc: imp });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Errore conferma import", error: err.message });
  }
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`Gestionale avviato su porta ${PORT}`);
});
