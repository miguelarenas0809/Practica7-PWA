const express = require("express");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

const FILAS = 8, COLS = 10, LETRAS = "ABCDEFGH", MAX_POR_COMPRA = 8;
const precio = r => (r < 3 ? 70 : r < 6 ? 90 : 110);   // el servidor es quien calcula el total

// ===== Base de datos =====
const db = new Database(process.env.DB || path.join(__dirname, "cine.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY, nombre TEXT NOT NULL UNIQUE COLLATE NOCASE,
  salt TEXT NOT NULL, pin_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sesiones (
  token TEXT PRIMARY KEY, usuario_id INTEGER NOT NULL REFERENCES usuarios(id));
CREATE TABLE IF NOT EXISTS funciones (
  id INTEGER PRIMARY KEY, peli TEXT NOT NULL, hora TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS compras (
  id INTEGER PRIMARY KEY, usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  funcion_id INTEGER NOT NULL REFERENCES funciones(id),
  total INTEGER NOT NULL, fecha TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS asientos (          -- la matriz, una fila por asiento
  funcion_id INTEGER NOT NULL REFERENCES funciones(id),
  fila INTEGER NOT NULL, col INTEGER NOT NULL,
  ocupado INTEGER NOT NULL DEFAULT 0,          -- 0 libre, 1 vendido
  compra_id INTEGER REFERENCES compras(id),    -- NULL si ya venía ocupado de origen
  PRIMARY KEY (funcion_id, fila, col));
`);

// Datos iniciales (solo la primera vez)
if (!db.prepare("SELECT 1 FROM funciones").get()) {
  const insF = db.prepare("INSERT INTO funciones(peli, hora) VALUES (?, ?)");
  const insA = db.prepare("INSERT INTO asientos(funcion_id, fila, col, ocupado) VALUES (?, ?, ?, ?)");
  db.transaction(() => {
    [["Noche en el Observatorio", "16:30"], ["El último tren", "19:00"], ["Aventura submarina", "21:15"]]
      .forEach(([peli, hora]) => {
        const id = insF.run(peli, hora).lastInsertRowid;
        for (let r = 0; r < FILAS; r++)
          for (let c = 0; c < COLS; c++) insA.run(id, r, c, Math.random() < 0.2 ? 1 : 0);
      });
  })();
}

// ===== Compra atómica =====
// Todo ocurre en una transacción: si UN asiento ya estaba vendido, se deshace TODA la compra.
const insCompra = db.prepare("INSERT INTO compras(usuario_id, funcion_id, total, fecha) VALUES (?, ?, ?, ?)");
const marcar = db.prepare("UPDATE asientos SET ocupado = 1, compra_id = ? WHERE funcion_id = ? AND fila = ? AND col = ? AND ocupado = 0");
const comprar = db.transaction((uid, fid, seats) => {
  const total = seats.reduce((s, [r]) => s + precio(r), 0);
  const id = insCompra.run(uid, fid, total, new Date().toISOString()).lastInsertRowid;
  const ocupados = seats.filter(([r, c]) => marcar.run(id, fid, r, c).changes !== 1);
  if (ocupados.length) throw Object.assign(new Error("conflicto"), { ocupados });
  return { id, total };
});

// ===== Sesiones =====
const hash = (pin, salt) => crypto.scryptSync(pin, salt, 32).toString("hex");

function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  const u = db.prepare("SELECT u.id, u.nombre FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id WHERE s.token = ?").get(token);
  if (!u) return res.status(401).json({ error: "Sesión no válida. Inicia sesión de nuevo." });
  req.usuario = u;
  next();
}

// ===== API =====
const app = express();
app.use(express.json({ limit: "10kb" }));

// Entrar: si el nombre no existe se crea la cuenta; si existe se verifica el PIN
app.post("/api/sesion", (req, res) => {
  const nombre = String((req.body || {}).nombre || "").trim().slice(0, 40);
  const pin = String((req.body || {}).pin || "");
  if (!nombre || !/^\d{4}$/.test(pin))
    return res.status(400).json({ error: "Escribe tu nombre y un PIN de 4 dígitos." });

  let u = db.prepare("SELECT * FROM usuarios WHERE nombre = ?").get(nombre);
  if (!u) {
    const salt = crypto.randomBytes(16).toString("hex");
    const id = db.prepare("INSERT INTO usuarios(nombre, salt, pin_hash) VALUES (?, ?, ?)").run(nombre, salt, hash(pin, salt)).lastInsertRowid;
    u = { id, nombre };
  } else {
    const ok = crypto.timingSafeEqual(Buffer.from(hash(pin, u.salt)), Buffer.from(u.pin_hash));
    if (!ok) return res.status(401).json({ error: "PIN incorrecto para ese nombre." });
  }
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO sesiones(token, usuario_id) VALUES (?, ?)").run(token, u.id);
  res.json({ token, nombre: u.nombre });
});

app.get("/api/funciones", (req, res) => {
  res.json({ funciones: db.prepare("SELECT id, peli, hora FROM funciones ORDER BY id").all() });
});

// Mapa público: solo libre/ocupado, nunca quién compró
app.get("/api/funciones/:id/asientos", (req, res) => {
  const filas = db.prepare("SELECT fila, col, ocupado FROM asientos WHERE funcion_id = ?").all(req.params.id);
  if (!filas.length) return res.status(404).json({ error: "La función no existe." });
  const matriz = Array.from({ length: FILAS }, () => Array(COLS).fill(0));
  filas.forEach(a => (matriz[a.fila][a.col] = a.ocupado));
  res.json({ matriz });
});

app.post("/api/compras", auth, (req, res) => {
  const { funcionId, asientos } = req.body || {};
  const valido = Array.isArray(asientos) && asientos.length >= 1 && asientos.length <= MAX_POR_COMPRA &&
    asientos.every(a => Array.isArray(a) && Number.isInteger(a[0]) && Number.isInteger(a[1]) &&
      a[0] >= 0 && a[0] < FILAS && a[1] >= 0 && a[1] < COLS) &&
    new Set(asientos.map(a => a.join("-"))).size === asientos.length;
  if (!valido) return res.status(400).json({ error: `Elige de 1 a ${MAX_POR_COMPRA} asientos válidos.` });
  if (!db.prepare("SELECT 1 FROM funciones WHERE id = ?").get(funcionId))
    return res.status(404).json({ error: "La función no existe." });

  try {
    const { id, total } = comprar(req.usuario.id, funcionId, asientos);
    res.status(201).json({ folio: "T" + String(id).padStart(5, "0"), total, asientos: asientos.map(([r, c]) => LETRAS[r] + (c + 1)) });
  } catch (e) {
    if (e.ocupados) return res.status(409).json({ error: "Algún asiento ya no está disponible.", ocupados: e.ocupados });
    throw e;
  }
});

// "Mis boletos": solo las compras del usuario de la sesión
app.get("/api/mis-compras", auth, (req, res) => {
  const compras = db.prepare(`SELECT c.id, c.total, c.fecha, f.peli, f.hora FROM compras c
    JOIN funciones f ON f.id = c.funcion_id WHERE c.usuario_id = ? ORDER BY c.id DESC`).all(req.usuario.id);
  const getAs = db.prepare("SELECT fila, col FROM asientos WHERE compra_id = ? ORDER BY fila, col");
  res.json({
    compras: compras.map(c => ({
      folio: "T" + String(c.id).padStart(5, "0"), peli: c.peli, hora: c.hora, total: c.total, fecha: c.fecha,
      asientos: getAs.all(c.id).map(a => LETRAS[a.fila] + (a.col + 1))
    }))
  });
});

app.use(express.static(path.join(__dirname, "public")));
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: "Error del servidor." }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Sala de cine en http://localhost:${PORT}`));
