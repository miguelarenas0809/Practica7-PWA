# Sala de Cine - PWA

Aplicación web progresiva (PWA) para simular la compra de boletos de una sala de cine. Los asientos se representan con una matriz, varios clientes pueden ver cuáles están disponibles y comprarlos, y un servidor central evita que el mismo asiento se venda dos veces.

## Características

- **Mapa de asientos:** sala de 8 filas (A–H) por 10 columnas, con pasillo central. Cada asiento se ve como libre, seleccionado o vendido.
- **Tres funciones**, cada una con su propia matriz de asientos.
- **Compra atómica:** si dos clientes piden el mismo asiento al mismo tiempo, solo uno lo obtiene. Si un asiento de la compra falla, no se vende ninguno de los solicitados.
- **Cuentas con PIN:** cada cliente entra con un nombre y un PIN de 4 dígitos. Si el nombre no existe, se crea la cuenta.
- **Boletos privados:** «Mis boletos» muestra solo las compras de la sesión actual. El mapa público indica si un asiento está libre u ocupado, nunca quién lo compró.
- **Mapa compartido y actualizado:** se refresca solo cada 3 segundos y avisa si alguien compra un asiento que tenías seleccionado.
- **Instalable:** incluye manifiesto y service worker.
- **Precios por zona:** filas A–C $70, D–F $90 y G–H $110 (VIP).

## Tecnologías

| Parte | Tecnología |
|---|---|
| Cliente | HTML, CSS y JavaScript (sin frameworks) |
| PWA | Web App Manifest y Service Worker |
| Servidor | Node.js y Express |
| Base de datos | SQLite con `better-sqlite3` |

## Estructura del proyecto

```
sala-terciopelo/
├── server.js                 # Servidor Express y API
├── package.json
└── public/                   # Archivos de la PWA
    ├── index.html            # Interfaz y lógica del cliente
    ├── sw.js                 # Service worker
    ├── manifest.webmanifest  # Manifiesto de la PWA
    ├── icon-192.png
    └── icon-512.png
```

Al ejecutar el proyecto se generan además `node_modules/`, `package-lock.json` y la base de datos `cine.db` (junto con `cine.db-wal` y `cine.db-shm`). No hace falta crearlos a mano.

## Requisitos

- Node.js 18 o superior (se recomienda una versión LTS reciente; el proyecto se probó con Node 22).
- npm.
- Si `better-sqlite3` no encuentra una versión precompilada para tu sistema, necesitará herramientas de compilación. En Ubuntu o Debian: `sudo apt install build-essential python3`.

## Instalación y uso

```bash
git clone https://github.com/TU_USUARIO/sala-terciopelo.git
cd sala-terciopelo
npm install
npm start
```

Abre `http://localhost:3000` en el navegador.


### Reiniciar la simulación

Borra la base de datos y la próxima vez que arranque el servidor se crea una sala nueva, sin compras ni cuentas:

```bash
npm run reset
```

### Probar desde otro dispositivo

El servidor escucha en todas las interfaces de red. Con el celular conectado a la misma red wifi, abre `http://IP_DE_TU_PC:3000`. Para ver la IP en Linux, ejecuta `hostname -I`.

> Los navegadores solo ofrecen instalar la app como PWA desde `localhost` o con HTTPS. Por una IP sin HTTPS puedes usarla, pero no instalarla.

## API

| Método y ruta | Descripción | Requiere sesión |
|---|---|---|
| `POST /api/sesion` | Inicia sesión o crea la cuenta. Recibe `nombre` y `pin`. Devuelve un token. | No |
| `GET /api/funciones` | Lista las funciones. | No |
| `GET /api/funciones/:id/asientos` | Devuelve la matriz de la función (0 libre, 1 vendido). | No |
| `POST /api/compras` | Compra asientos. Recibe `funcionId` y `asientos` (pares `[fila, columna]`). Responde 409 si alguno ya está vendido. | Sí |
| `GET /api/mis-compras` | Devuelve las compras del usuario de la sesión. | Sí |

Las rutas protegidas esperan el encabezado `Authorization: Bearer <token>`.

## Cómo funciona

### La sala como matriz

Cada asiento es un registro de la tabla `asientos`, identificado por función, fila y columna. Al consultar una función, el servidor lo convierte en una matriz de 8 × 10, donde `matriz[2][4]` corresponde al asiento C5.

### Compra atómica

La compra se ejecuta dentro de una transacción. Cada asiento se marca como vendido solo si sigue libre (`UPDATE ... WHERE ocupado = 0`). Si alguno falla, la transacción se revierte completa y el servidor responde con el código 409 y la lista de asientos en conflicto.

### Validación en el servidor

El servidor comprueba que los asientos existan, no se repitan y no sean más de 8, y calcula él mismo el total. El precio que muestra la interfaz es solo informativo.

### Autenticación

El PIN se guarda como hash `scrypt` con una sal aleatoria por usuario. Tras iniciar sesión, el servidor entrega un token aleatorio que el navegador envía en cada petición protegida.

### Service worker

Las peticiones a `/api/` nunca se guardan en caché, porque los asientos deben ser siempre los reales. Los archivos de la app usan la estrategia de red primero, con copia guardada como respaldo si no hay conexión. La app instalada puede abrirse sin internet, pero necesita el servidor para ver la sala y comprar.
