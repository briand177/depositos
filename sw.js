// Service worker de la app Depósitos.
// 1) Recibe los comprobantes compartidos desde WhatsApp (menú Compartir),
//    los guarda y abre la app, que los lee.
// 2) Hace los pedidos al script en lugar de la página: así siguen aunque cambies
//    de app. Las respuestas quedan guardadas hasta que la app las muestra.
// 3) Guarda una copia de la app para que abra rápido aunque haya mala señal.
//    Siempre intenta primero la versión de internet, así los cambios llegan solos.

const VERSION = 2;
const CACHE_APP = 'app-v' + VERSION;
const ARCHIVOS = ['./', './index.html', './manifest.webmanifest', './icono-192.png', './icono-512.png'];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE_APP).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(claves => Promise.all(claves
        .filter(k => k.indexOf('app-') === 0 && k !== CACHE_APP)
        .map(k => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname.endsWith('/compartir')) {
    ev.respondWith(guardarCompartido(req));
    return;
  }

  // Solo archivos propios de la app; las llamadas al script de Google pasan directo.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  ev.respondWith(
    fetch(req)
      .then(resp => {
        if (resp.ok) {
          const copia = resp.clone();
          caches.open(CACHE_APP).then(c => c.put(req, copia));
        }
        return resp;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then(r => r || caches.match('./index.html'))));
});

async function guardarCompartido(req) {
  let cantidad = 0;
  try {
    const form = await req.formData();
    const archivos = form.getAll('comprobante').filter(f => f && typeof f !== 'string');
    const cache = await caches.open('compartidos');
    for (const f of archivos) {
      const clave = new Request('./compartido/' + Date.now() + '-' + cantidad);
      await cache.put(clave, new Response(f, {
        headers: {
          'Content-Type': f.type || 'application/octet-stream',
          'X-Nombre': encodeURIComponent(f.name || '')
        }
      }));
      cantidad++;
    }
  } catch (e) {
    // Si algo falla igual abrimos la app; el usuario puede usar el botón 📎.
  }
  return Response.redirect(new URL('./?compartido=' + cantidad, self.registration.scope).href, 303);
}


// ---------- Pedidos al script ----------
// Las cargas van en fila (una detrás de otra, en el orden en que se mandaron).
// Las lecturas de comprobantes van aparte, para no frenar las cargas.
let cola = Promise.resolve();

self.addEventListener('message', ev => {
  const d = ev.data || {};
  if (d.tipo === 'version') {
    if (ev.source) ev.source.postMessage({ tipo: 'version', v: VERSION });
    return;
  }
  if (d.tipo !== 'api') return;

  const trabajo = () => pedir(d).then(entregar);
  let p;
  if (d.accion === 'comando') {
    p = cola.then(trabajo);
    cola = p.catch(() => {});
  } else {
    p = trabajo();
  }
  ev.waitUntil(p); // mantiene vivo al service worker hasta terminar
});

const esperar = ms => new Promise(r => setTimeout(r, ms));

// Si se corta la conexión reintenta (hasta 3 veces). Es seguro: el script
// reconoce el id y no carga dos veces lo mismo.
async function pedir(d) {
  const base = { id: d.id, accion: d.accion, texto: d.texto };
  let detalle = '';
  for (let intento = 0; intento < 3; intento++) {
    if (intento) await esperar(3000 * intento);
    const ctrl = new AbortController();
    const corte = setTimeout(() => ctrl.abort(), 150000);
    try {
      const resp = await fetch(d.url, { method: 'POST', body: d.cuerpo, signal: ctrl.signal });
      const cuerpo = await resp.text();
      return Object.assign(base, { estado: 'ok', cuerpo: cuerpo, t: Date.now() });
    } catch (e) {
      if (e && e.name === 'AbortError') return Object.assign(base, { estado: 'error', error: 'tiempo', t: Date.now() });
      detalle = String(e && e.message || e);
    } finally {
      clearTimeout(corte);
    }
  }
  return Object.assign(base, { estado: 'error', error: 'red', detalle: detalle, t: Date.now() });
}

// Guarda la respuesta (por si la app está cerrada) y avisa a la app si está abierta.
async function entregar(r) {
  const cache = await caches.open('resultados');
  await cache.put(new Request('./resultado/' + r.id),
    new Response(JSON.stringify(r), { headers: { 'Content-Type': 'application/json' } }));
  const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  ventanas.forEach(v => v.postMessage({ tipo: 'resultado', r: r }));
}
