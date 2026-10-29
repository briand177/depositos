// Service worker de la app Depósitos.
// 1) Recibe los comprobantes compartidos desde WhatsApp (menú Compartir),
//    los guarda y abre la app, que los lee.
// 2) Guarda una copia de la app para que abra rápido aunque haya mala señal.
//    Siempre intenta primero la versión de internet, así los cambios llegan solos.

const CACHE_APP = 'app-v1';
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
