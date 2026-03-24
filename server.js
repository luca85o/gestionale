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
  ssl: { rejectUnauthorized: false }
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
function ensureStock(db, warehouseId, productId) {
  let stock = db.stocks.find(
    s => Number(s.warehouseId) === Number(warehouseId) && Number(s.productId) === Number(productId)
  );
  if (!stock) {
    stock = {
      id: nextId(db.stocks),
      warehouseId: Number(warehouseId),
      productId: Number(productId),
      qty: 0,
      minQty: 0
    };
    db.stocks.push(stock);
  }
  return stock;
}
function lowStock(db) {
  return db.stocks.filter(s => Number(s.qty) <= Number(s.minQty || 0));
}
function textIncludes(v, q) {
  return String(v || "").toLowerCase().includes(q);
}
function productName(db, id) {
  return db.products.find(x => Number(x.id) === Number(id))?.name || "";
}
function supplierName(db, id) {
  return db.suppliers.find(x => Number(x.id) === Number(id))?.name || "";
}
function clientName(db, id) {
  return db.clients.find(x => Number(x.id) === Number(id))?.name || "";
}
function warehouseName(db, id) {
  return db.warehouses.find(x => Number(x.id) === Number(id))?.name || "";
}
function partnerName(db, type, id) {
  return type === "supplier" ? supplierName(db, id) : clientName(db, id);
}

function normalizeText(s) {
  return String(s || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
function detectSupplierIdFromText(db, text) {
  const t = String(text || "").toLowerCase();
  if (t.includes("cimmino")) return (db.suppliers.find(s => /cimmino/i.test(s.name)) || {}).id || null;
  return null;
}
function parseCimminoRows(text) {
  const rows = [];
  const lines = String(text || "")
    .split(/\r?\n/)
    .map(x => normalizeText(x))
    .filter(Boolean);

  for (const line of lines) {
    let m = line.match(
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
function guessProductForRow(db, row, direction, supplierId) {
  const aliasType = "supplier";
  const code = String(row.supplierCode || "").trim().toLowerCase();
  const desc = normalizeAliasText(row.description || "");
  const size = extractSizeToken(row.description || "");
  const aliases = db.aliases.filter(a => String(a.aliasType || "supplier") === aliasType);

  if (code) {
    const byCode = aliases.find(a => String(a.supplierCode || "").trim().toLowerCase() === code);
    if (byCode) return byCode.productId;
  }
  if (desc) {
    const byDesc = aliases.find(a => normalizeAliasText(a.supplierDescription || "") === desc);
    if (byDesc) return byDesc.productId;
  }
  const p = db.products.find(p => {
    const pt = normalizeAliasText(`${p.name || ""} ${p.sku || ""} ${p.category || ""} ${p.size || ""}`);
    const psize = extractSizeToken(`${p.name || ""} ${p.size || ""}`);
    const sameSize = !size || !psize || psize === size;
    return sameSize && pt && (pt.includes(desc) || desc.includes(pt));
  });
  return p ? p.id : "";
}
async function parsePdfRows(filePath, direction) {
  try {
    const buffer = fs.readFileSync(filePath);
    const parsed = await pdf(buffer);
    const text = parsed.text || "";
    const db = readDB();

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

function applyMovement(db, movement) {
  for (const row of movement.rows) {
    if (row.fulfillmentSource !== "warehouse") continue;
    if (movement.type === "carico") {
      const s = ensureStock(db, movement.warehouseId, row.productId);
      s.qty += Number(row.qty);
    } else if (movement.type === "scarico") {
      const s = ensureStock(db, movement.warehouseId, row.productId);
      s.qty = Math.max(-999999, Number(s.qty) - Number(row.qty));
    } else if (movement.type === "trasferimento") {
      const from = ensureStock(db, movement.warehouseId, row.productId);
      const to = ensureStock(db, movement.destinationWarehouseId, row.productId);
      from.qty = Math.max(-999999, Number(from.qty) - Number(row.qty));
      to.qty += Number(row.qty);
    }
  }
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
    products: db.products.filter(x => [x.name, x.sku, x.category, x.color, x.size, x.notes].some(v => textIncludes(v, q))),
    suppliers: db.suppliers.filter(x => [x.name, x.vat, x.email, x.phone, x.contact, x.notes].some(v => textIncludes(v, q))),
    clients: db.clients.filter(x => [x.name, x.vat, x.email, x.phone, x.contact, x.notes].some(v => textIncludes(v, q))),
    warehouses: db.warehouses.filter(x => [x.name, x.city, x.address].some(v => textIncludes(v, q))),
    stocks: db.stocks.filter(x =>
      [productName(db, x.productId), warehouseName(db, x.warehouseId), x.qty, x.minQty].some(v => textIncludes(v, q))
    ),
    movements: db.movements.filter(x =>
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
    aliases: db.aliases.filter(x =>
      [x.aliasType, supplierName(db, x.supplierId), x.supplierCode, x.ean, x.supplierDescription, productName(db, x.productId)].some(
        v => textIncludes(v, q)
      )
    ),
    documents: db.imports.filter(x =>
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

app.get("/api/bootstrap", async (req, res) => {
  try {
    const db = readDB();
    let users = [];
    try {
      users = await getUsersFromPostgres();
    } catch (e) {
      users = db.users || [];
    }

    res.json({
      ok: true,
      ...db,
      users,
      lowStock: lowStock(db)
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: "Errore bootstrap", error: e.message });
  }
});

app.get("/api/search", (req, res) => {
  const db = readDB();
  res.json(searchAll(db, req.query.q || ""));
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    const result = await pool.query(
      `
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
      `,
      [String(email || "")]
    );

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

    const result = await pool.query(
      `
      insert into users(name, email, password_hash, role_key)
      values($1, $2, $3, $4)
      returning id, name, email, role_key
      `,
      [
        String(name || ""),
        String(email || ""),
        hash,
        String(roleKey || "viewer")
      ]
    );

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

for (const name of ["suppliers", "clients", "warehouses", "products", "aliases"]) {
  app.get(`/api/${name}`, (req, res) => {
    const db = readDB();
    const q = String(req.query.q || "").trim().toLowerCase();
    const list = !q ? db[name] : db[name].filter(x => Object.values(x).some(v => textIncludes(v, q)));
    res.json(list);
  });

  app.post(`/api/${name}`, (req, res) => {
    const db = readDB();
    const item = { id: nextId(db[name]), ...req.body };
    db[name].push(item);
    writeDB(db);
    res.json(item);
  });
}

app.get("/api/stocks", (req, res) => {
  const db = readDB();
  const q = String(req.query.q || "").trim().toLowerCase();
  const list = !q ? db.stocks : db.stocks.filter(x =>
    [productName(db, x.productId), warehouseName(db, x.warehouseId), x.qty, x.minQty].some(v => textIncludes(v, q))
  );
  res.json(list);
});

app.put("/api/stocks/:id", (req, res) => {
  const db = readDB();
  const item = db.stocks.find(x => Number(x.id) === Number(req.params.id));
  if (!item) return res.status(404).json({ ok: false, message: "Giacenza non trovata" });
  item.qty = Number(req.body.qty ?? item.qty);
  item.minQty = Number(req.body.minQty ?? item.minQty);
  writeDB(db);
  res.json(item);
});

app.get("/api/movements", (req, res) => {
  const db = readDB();
  const q = String(req.query.q || "").trim().toLowerCase();
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
});

app.post("/api/movements", (req, res) => {
  const db = readDB();
  const movement = {
    id: nextId(db.movements),
    type: req.body.type,
    date: req.body.date,
    warehouseId: Number(req.body.warehouseId),
    destinationWarehouseId: req.body.destinationWarehouseId ? Number(req.body.destinationWarehouseId) : null,
    partnerType: req.body.partnerType || null,
    partnerId: req.body.partnerId ? Number(req.body.partnerId) : null,
    orderNo: req.body.orderNo || "",
    invoiceNo: req.body.invoiceNo || "",
    ddtNo: req.body.ddtNo || "",
    notes: req.body.notes || "",
    rows: (req.body.rows || []).map(r => ({
      productId: Number(r.productId),
      qty: Number(r.qty),
      fulfillmentSource: r.fulfillmentSource || "warehouse",
      stockImpact: r.fulfillmentSource === "warehouse"
    }))
  };
  applyMovement(db, movement);
  db.movements.unshift(movement);
  writeDB(db);
  res.json(movement);
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

    const result = await pool.query(
      `
      insert into users(name, email, password_hash, role_key)
      values($1, $2, $3, $4)
      returning id, name, email, role_key
      `,
      [
        String(body.name || ""),
        String(body.email || ""),
        hash,
        String(body.roleKey || "viewer")
      ]
    );

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

app.get("/api/imports", (req, res) => {
  const db = readDB();
  const q = String(req.query.q || "").trim().toLowerCase();
  const list = !q ? db.imports : db.imports.filter(x =>
    [x.documentDirection, x.documentType, x.documentNo, x.documentDate, x.originalFileName, x.status, supplierName(db, x.supplierId), clientName(db, x.clientId)].some(v =>
      textIncludes(v, q)
    )
  );
  res.json(list);
});

app.post("/api/imports/upload", upload.single("document"), async (req, res) => {
  const db = readDB();
  const body = req.body || {};
  const direction = body.documentDirection || "supplier";

  let parserResult = { rows: [], detectedSupplierId: null, parser: "none" };
  if (req.file) parserResult = await parsePdfRows(req.file.path, direction);

  const finalSupplierId = body.supplierId ? Number(body.supplierId) : parserResult.detectedSupplierId || null;

  const importDoc = {
    id: nextId(db.imports),
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

  let parsedRows = (parserResult.rows || []).map(row => ({
    ...row,
    productId: row.productId || guessProductForRow(db, row, direction, finalSupplierId || 0)
  }));

  importDoc.rows = parsedRows;
  db.imports.unshift(importDoc);
  writeDB(db);
  res.json({ ...importDoc, parsedRows, detectedSupplierId: finalSupplierId, parser: parserResult.parser });
});

app.post("/api/imports/:id/rows", (req, res) => {
  const db = readDB();
  const imp = db.imports.find(x => Number(x.id) === Number(req.params.id));
  if (!imp) return res.status(404).json({ ok: false, message: "Import non trovato" });
  imp.rows = req.body.rows || [];
  imp.status = "mapped";
  writeDB(db);
  res.json(imp);
});

app.post("/api/imports/:id/confirm", (req, res) => {
  const db = readDB();
  const imp = db.imports.find(x => Number(x.id) === Number(req.params.id));
  if (!imp) return res.status(404).json({ ok: false, message: "Import non trovato" });

  const rows = (imp.rows || [])
    .filter(r => r.action !== "ignore" && r.productId)
    .map(r => ({
      productId: Number(r.productId),
      qty: Number(r.qty),
      fulfillmentSource: r.fulfillmentSource || "warehouse",
      stockImpact: (r.fulfillmentSource || "warehouse") === "warehouse"
    }));

  const movement = {
    id: nextId(db.movements),
    type: imp.documentDirection === "supplier" ? "carico" : "scarico",
    date: imp.documentDate || new Date().toISOString().slice(0, 10),
    warehouseId: Number(imp.warehouseId || 301),
    destinationWarehouseId: null,
    partnerType: imp.documentDirection === "supplier" ? "supplier" : "client",
    partnerId: Number(imp.documentDirection === "supplier" ? imp.supplierId : imp.clientId),
    orderNo: "",
    invoiceNo: imp.documentType === "fattura" ? imp.documentNo : "",
    ddtNo: imp.documentType === "ddt" ? imp.documentNo : "",
    notes: `Import documento ${imp.documentDirection} ${imp.documentType} ${imp.documentNo}`.trim(),
    rows
  };

  applyMovement(db, movement);
  db.movements.unshift(movement);

  for (const row of imp.rows || []) {
    if (row.productId && row.createAlias && (row.supplierCode || row.ean || row.description)) {
      const aliasType = imp.documentDirection === "supplier" ? "supplier" : "sale";
      const already = db.aliases.find(
        a =>
          String(a.aliasType || "supplier") === aliasType &&
          String(a.supplierCode || "") === String(row.supplierCode || "") &&
          String(a.ean || "") === String(row.ean || "") &&
          Number(a.productId) === Number(row.productId)
      );

      if (!already) {
        db.aliases.push({
          id: nextId(db.aliases),
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
  writeDB(db);
  res.json({ ok: true, movement, importDoc: imp });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`Gestionale avviato su porta ${PORT}`);
});
