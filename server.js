import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";

// Import por namespace: se algum export opcional não existir na versão
// instalada, o servidor não quebra na inicialização.
import * as gplay from "@mradex77/google-play-scraper";

const {
  memoized,
  createClient,
  createCountryFetch,
  category,
  collection,
  sort,
  age,
  permission,
  GooglePlayError,
  ValidationError,
  HttpError,
  NotFoundError,
  RateLimitError,
  BlockedError,
  ParseError,
  SpecError
} = gplay;

const app = express();
const PORT = process.env.PORT || 10000;

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(helmet());
app.use(express.json({ limit: "20kb" }));

// ---------------- CONFIGURAÇÃO ----------------

const DEFAULT_COUNTRY = "br";
const DEFAULT_LANG = "pt";
const THROTTLE = 3; // requisições por segundo ao Google Play
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 500;

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RETRIES = 2;

// ---------------- MÉTRICAS E DIAGNÓSTICO ----------------

const metrics = {
  startedAt: new Date().toISOString(),
  requests: 0,
  responses: 0,
  retries: 0,
  degradations: 0,
  integrityEvents: 0,
  totalLatencyMs: 0,
  byStatus: {}
};

const DIAG_MAX = 200;
const diagnostics = [];

function record(type, data) {
  diagnostics.push({ at: new Date().toISOString(), type, ...data });
  if (diagnostics.length > DIAG_MAX) diagnostics.shift();
}

// Referências estáveis (importante: funções entram na chave do cache
// do cliente memoizado por identidade).
const onDegradation = (event) => {
  metrics.degradations++;
  record("degradation", {
    context: event.context,
    reason: event.reason,
    message: event.error?.message
  });
  console.warn("[degradation]", event.context, event.reason);
};

const onIntegrityEvent = (event) => {
  metrics.integrityEvents++;
  record("integrity", {
    context: event.context,
    reason: event.reason,
    message: event.error?.message
  });
  console.warn("[integrity]", event.context, event.reason);
};

// Hooks de ciclo de vida das requisições (telemetria apenas).
const onRequest = () => {
  metrics.requests++;
};

const onResponse = (event) => {
  metrics.responses++;
  metrics.totalLatencyMs += event.durationMs || 0;
  metrics.byStatus[event.status] = (metrics.byStatus[event.status] || 0) + 1;
};

const onRetry = (event) => {
  metrics.retries++;
  record("retry", {
    attempt: event.attempt,
    delayMs: event.delayMs,
    reason: event.reason,
    status: event.status
  });
};

// ---------------- PROXY POR PAÍS (OPCIONAL) ----------------
// Variáveis de ambiente:
//   PROXY_URL = proxy padrão (fallback)
//   PROXY_US, PROXY_DE, PROXY_BR ... = proxy específico por país (gl=<país>)
// Requer o pacote "undici" (veja package.json). Sem variáveis, conexão direta.

async function buildFetchImpl() {
  const fallbackUrl = process.env.PROXY_URL;
  const perCountryUrls = {};

  for (const [key, value] of Object.entries(process.env)) {
    const match = /^PROXY_([A-Z]{2})$/.exec(key);
    if (match && value) perCountryUrls[match[1].toLowerCase()] = value;
  }

  if (!fallbackUrl && Object.keys(perCountryUrls).length === 0) {
    return undefined;
  }

  if (typeof createCountryFetch !== "function") {
    console.warn("createCountryFetch indisponível; proxies ignorados.");
    return undefined;
  }

  let undici;

  try {
    undici = await import("undici");
  } catch {
    console.warn("Pacote undici não instalado; proxies ignorados.");
    return undefined;
  }

  const throughProxy = (proxyUrl) => {
    const dispatcher = new undici.ProxyAgent(proxyUrl);
    return (input, init) => undici.fetch(input, { ...init, dispatcher });
  };

  const perCountry = {};
  for (const [cc, url] of Object.entries(perCountryUrls)) {
    perCountry[cc] = throughProxy(url);
  }

  console.log(
    "Proxy por país ativo:",
    Object.keys(perCountry).join(",") || "(somente fallback)"
  );

  return createCountryFetch({
    perCountry,
    ...(fallbackUrl ? { fallback: throughProxy(fallbackUrl) } : {})
  });
}

const FETCH_IMPL = await buildFetchImpl();

// Pool de requestOptions com referências estáveis, para que o cache do
// cliente memoizado continue funcionando mesmo com timeout/retries variáveis.
const requestOptionsPool = new Map();

function requestOptionsFor(timeoutMs, retries) {
  const key = timeoutMs + ":" + retries;
  let options = requestOptionsPool.get(key);

  if (!options) {
    options = {
      timeoutMs,
      retries,
      onRequest,
      onResponse,
      onRetry,
      ...(FETCH_IMPL ? { fetchImpl: FETCH_IMPL } : {})
    };
    requestOptionsPool.set(key, options);
  }

  return options;
}

const BASE_REQUEST_OPTIONS = requestOptionsFor(
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRIES
);

// Cliente com cache: usado nas consultas pontuais.
const cached = memoized({
  maxAgeMs: CACHE_TTL_MS,
  max: CACHE_MAX
});

// Cliente com limitador compartilhado: usado nos iteradores,
// reviewsAll e coletas longas (sem cache, com cancelamento por AbortSignal).
const live = createClient({
  country: DEFAULT_COUNTRY,
  lang: DEFAULT_LANG,
  throttle: 5,
  requestOptions: BASE_REQUEST_OPTIONS
});

// ---------------- LISTA DE ROTAS ----------------

const routes = [
  { method: "GET", path: "/", description: "Informações da API" },
  { method: "GET", path: "/health", description: "Health check" },
  { method: "GET", path: "/api/search", params: "q, num(1-250), price(all|free|paid), fullDetail, country, lang" },
  { method: "GET", path: "/api/search/stream", params: "q, maxItems(1-250), country, lang" },
  { method: "GET", path: "/api/app/:appId", params: "country, lang" },
  { method: "GET", path: "/api/apps", params: "appIds (separados por vírgula, 1-250), concurrency(1-20), country, lang" },
  { method: "GET", path: "/api/suggest", params: "q, country, lang" },
  { method: "GET", path: "/api/list", params: "collection, category, age, num(1-500), fullDetail, country, lang" },
  { method: "GET", path: "/api/developer", params: "devId, num(1-500), fullDetail, country, lang" },
  { method: "GET", path: "/api/developer/stream", params: "devId, maxItems(1-250), country, lang" },
  { method: "GET", path: "/api/similar/:appId", params: "fullDetail, country, lang" },
  { method: "GET", path: "/api/reviews/:appId", params: "num(1-4500), sort, paginate, nextPaginationToken, score(1-5, filtro local), country, lang" },
  { method: "GET", path: "/api/reviews/stream/:appId", params: "maxItems(1-500), sort, nextPaginationToken, score(1-5, filtro local), country, lang" },
  { method: "GET", path: "/api/reviews/all/:appId", params: "maxReviews(1-5000), sort, score(1-5, filtro local), country, lang" },
  { method: "GET", path: "/api/permissions/:appId", params: "short, country, lang" },
  { method: "GET", path: "/api/data-safety/:appId", params: "country, lang" },
  { method: "GET", path: "/api/availability/:appId", params: "countries (ex: br,us,de; 1-50), concurrency(1-20), lang" },
  { method: "GET", path: "/api/categories", params: "" },
  { method: "GET", path: "/api/constants", params: "" },
  { method: "GET", path: "/api/cache", description: "Status do cache" },
  { method: "DELETE", path: "/api/cache", description: "Limpa o cache" },
  { method: "POST", path: "/api/cache/invalidate", params: "body: { method, options }" },
  { method: "GET", path: "/api/metrics", description: "Métricas das requisições ao Google Play (hooks onRequest/onResponse/onRetry)" },
  { method: "GET", path: "/api/diagnostics", params: "limit(1-200)", description: "Eventos recentes de onDegradation, onIntegrityEvent e retries" },
  { method: "GET", path: "/api/library", description: "Inventário de tudo que a biblioteca exporta" },
  { method: "GET", path: "/api/aso/keyword-rank", params: "appId, keywords (até 20, separadas por vírgula), num(1-250), country, lang", description: "Posição do app na busca para cada keyword" },
  { method: "GET", path: "/api/aso/keyword-expand", params: "q, mode(alphabet|digits|both|none), depth(1-2), maxQueries(1-150), onlyContaining, country, lang", description: "Expansão de keywords por autocomplete (long tails)" },
  { method: "GET", path: "/api/aso/compare", params: "appIds (2-10), own (opcional), topTerms(0-30), country, lang", description: "Comparador de concorrentes lado a lado" },
  { method: "GET", path: "/api/aso/reviews-analysis/:appId", params: "maxReviews(1-3000), sort, since(YYYY-MM-DD), country, lang", description: "Análise de avaliações: notas, evolução, termos, versões, respostas" }
];

// Parâmetros aceitos por TODAS as rotas /api que consultam o Google Play:
//   country, lang, throttle(1-20), timeoutMs(1000-120000), retries(0-5)

// ---------------- RATE LIMIT ----------------

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api", limiter);

// ---------------- HELPERS ----------------

function badRequest(message, code) {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

function fail(res, status, message, code, extra = {}) {
  return res.status(status).json({
    success: false,
    error: message,
    code,
    ...extra
  });
}

function str(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  return value.trim();
}

function intP(value, fallback, min, max) {
  if (value === undefined || value === "") return fallback;

  const n = Number(value);

  if (!Number.isInteger(n) || n < min || n > max) {
    throw badRequest(
      "Número deve estar entre " + min + " e " + max,
      "INVALID_NUMBER"
    );
  }

  return n;
}

function boolP(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;

  throw badRequest(
    "Valor booleano inválido. Use true ou false.",
    "INVALID_BOOLEAN"
  );
}

function requiredString(value, name) {
  const result = str(value);
  if (!result) throw badRequest(name + " obrigatório.", "MISSING_PARAMETER");
  if (result.length > 300) {
    throw badRequest(name + " muito longo.", "PARAMETER_TOO_LONG");
  }
  return result;
}

function appIdP(value) {
  const id = str(value);

  if (
    id.length > 200 ||
    !/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/.test(id)
  ) {
    throw badRequest(
      "appId inválido. Exemplo: com.spotify.music",
      "INVALID_APP_ID"
    );
  }

  return id;
}

function locale(req) {
  const country = str(req.query.country, DEFAULT_COUNTRY).toLowerCase();
  const lang = str(req.query.lang, DEFAULT_LANG).toLowerCase();

  if (!/^[a-z]{2}$/.test(country) || !/^[a-z]{2}$/.test(lang)) {
    throw badRequest(
      "country e lang devem conter duas letras.",
      "INVALID_LOCALE"
    );
  }

  return { country, lang };
}

function enumValue(source, value, name) {
  const key = str(String(value)).toUpperCase();
  const result = source?.[key];

  if (result === undefined) {
    throw badRequest(
      name + " inválido. Valores: " + Object.keys(source || {}).join(", "),
      "INVALID_ENUM"
    );
  }

  return result;
}

// Opções comuns para o cliente com cache (referências estáveis = cache funciona).
function common(req) {
  return {
    ...locale(req),
    ...reqTuning(req),
    onDegradation,
    onIntegrityEvent
  };
}

// Ajustes por requisição: ?throttle=1-20 &timeoutMs=1000-120000 &retries=0-5
function reqTuning(req) {
  const throttle = intP(req.query.throttle, THROTTLE, 1, 20);
  const timeoutMs =
    Math.round(
      intP(req.query.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 120000) / 1000
    ) * 1000;
  const retries = intP(req.query.retries, DEFAULT_RETRIES, 0, 5);

  return {
    throttle,
    requestOptions: requestOptionsFor(timeoutMs, retries)
  };
}

// Cancela a coleta se o cliente fechar a conexão antes do fim.
function abortSignal(req, res) {
  const controller = new AbortController();

  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  return controller.signal;
}

function liveOptions(req, res) {
  return {
    ...locale(req),
    requestOptions: {
      ...reqTuning(req).requestOptions,
      signal: abortSignal(req, res)
    },
    onDegradation,
    onIntegrityEvent
  };
}

// Filtro local por nota (a biblioteca não documenta filtro por score).
function scoreFilter(req) {
  if (req.query.score === undefined || req.query.score === "") return null;
  return intP(req.query.score, undefined, 1, 5);
}

function applyScore(list, score) {
  return score === null ? list : list.filter((r) => r.score === score);
}

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || "Erro desconhecido",
    status: error?.status
  };
}

function handle(res, error, fallback) {
  console.error(fallback, error);

  let status = error.status || 502;
  let code = error.code || error.name || "SCRAPER_ERROR";
  const extra = {};

  if (ValidationError && error instanceof ValidationError) status = 400;
  else if (NotFoundError && error instanceof NotFoundError) status = 404;
  else if (RateLimitError && error instanceof RateLimitError) status = 429;
  else if (BlockedError && error instanceof BlockedError) status = 503;
  else if (SpecError && error instanceof SpecError) {
    status = 502;
    code = "LAYOUT_CHANGED";
    if (error.failures) extra.failures = error.failures;
  } else if (ParseError && error instanceof ParseError) {
    status = 502;
    code = "PARSE_ERROR";
  } else if (HttpError && error instanceof HttpError && error.status) {
    status = 502;
  }

  if (error.type === "entity.parse.failed") {
    status = 400;
    code = "INVALID_JSON";
  }

  const exposeMessage = status === 400 || status === 404;

  return fail(
    res,
    status,
    exposeMessage ? error.message : fallback,
    code,
    extra
  );
}

function asyncRoute(fallback, callback) {
  return async (req, res) => {
    try {
      await callback(req, res);
    } catch (error) {
      if (res.headersSent) return;
      if (res.destroyed) return;
      handle(res, error, fallback);
    }
  };
}

// Consome um iterador assíncrono até maxItems e interrompe a busca.
async function take(iterator, maxItems, filter) {
  const results = [];

  for await (const item of iterator) {
    if (filter && !filter(item)) continue;
    results.push(item);
    if (results.length >= maxItems) break;
  }

  return results;
}

// ---------------- INFO PÚBLICA ----------------

app.get("/", (req, res) => {
  res.json({
    success: true,
    name: "Google Play ASO API",
    version: "5.0.0",
    library: "@mradex77/google-play-scraper",
    proxyEnabled: Boolean(FETCH_IMPL),
    node: process.version,
    defaults: { country: DEFAULT_COUNTRY, lang: DEFAULT_LANG },
    endpoints: routes
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "ok",
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// ---------------- SEARCH ----------------

app.get("/api/search", asyncRoute("Falha na pesquisa", async (req, res) => {
  const term = requiredString(req.query.q, "q");
  const price = str(req.query.price, "all").toLowerCase();

  if (!["all", "free", "paid"].includes(price)) {
    return fail(res, 400, "price deve ser all, free ou paid.", "INVALID_PRICE");
  }

  const results = await cached.search({
    term,
    price,
    num: intP(req.query.num, 20, 1, 250),
    fullDetail: boolP(req.query.fullDetail, false),
    ...common(req)
  });

  res.json({ success: true, query: term, count: results.length, results });
}));

app.get("/api/search/stream", asyncRoute("Falha no iterador de pesquisa", async (req, res) => {
  const term = requiredString(req.query.q, "q");
  const maxItems = intP(req.query.maxItems, 100, 1, 250);

  const results = await take(
    live.searchIterator({ term, ...liveOptions(req, res) }),
    maxItems
  );

  res.json({ success: true, query: term, count: results.length, maxItems, results });
}));

// ---------------- APP ----------------

app.get("/api/app/:appId", asyncRoute("Falha ao obter detalhes do aplicativo", async (req, res) => {
  const appId = appIdP(req.params.appId);

  const data = await cached.app({ appId, ...common(req) });

  res.json({ success: true, data });
}));

// ---------------- BATCH ----------------

app.get("/api/apps", asyncRoute("Falha na consulta em lote", async (req, res) => {
  const idsText = requiredString(req.query.appIds || req.query.ids, "appIds");

  // A biblioteca não remove duplicados; fazemos isso para economizar requisições.
  const appIds = [...new Set(idsText.split(",").map((id) => id.trim()))];

  if (appIds.length < 1 || appIds.length > 250 || appIds.some((id) => !id)) {
    return fail(
      res, 400,
      "Informe de 1 a 250 IDs separados por vírgula.",
      "INVALID_APP_IDS"
    );
  }

  appIds.forEach(appIdP);

  const raw = await cached.apps({
    appIds,
    concurrency: intP(req.query.concurrency, 5, 1, 20),
    ...common(req)
  });

  const results = raw.map((entry) =>
    entry.status === "fulfilled"
      ? { appId: entry.appId, status: "fulfilled", app: entry.app }
      : { appId: entry.appId, status: "rejected", error: serializeError(entry.error) }
  );

  res.json({
    success: true,
    count: results.length,
    succeeded: results.filter((r) => r.status === "fulfilled").length,
    failed: results.filter((r) => r.status === "rejected").length,
    results
  });
}));

// ---------------- SUGGEST ----------------

app.get("/api/suggest", asyncRoute("Falha nas sugestões", async (req, res) => {
  const term = requiredString(req.query.q, "q");

  const results = await cached.suggest({ term, ...common(req) });

  res.json({ success: true, query: term, count: results.length, results });
}));

// ---------------- LIST (TOP CHARTS) ----------------

app.get("/api/list", asyncRoute("Falha ao obter rankings", async (req, res) => {
  const collectionName = str(req.query.collection, "TOP_FREE").toUpperCase();
  const categoryName = str(req.query.category, "APPLICATION").toUpperCase();

  const options = {
    collection: enumValue(collection, collectionName, "collection"),
    category: enumValue(category, categoryName, "category"),
    num: intP(req.query.num, 30, 1, 500),
    fullDetail: boolP(req.query.fullDetail, false),
    ...common(req)
  };

  if (req.query.age !== undefined && req.query.age !== "") {
    options.age = enumValue(age, req.query.age, "age");
  }

  const results = await cached.list(options);

  res.json({
    success: true,
    collection: collectionName,
    category: categoryName,
    count: results.length,
    results
  });
}));

// ---------------- DEVELOPER ----------------

app.get("/api/developer", asyncRoute("Falha ao consultar desenvolvedor", async (req, res) => {
  const devId = requiredString(req.query.devId, "devId");

  const results = await cached.developer({
    devId,
    num: intP(req.query.num, 60, 1, 500),
    fullDetail: boolP(req.query.fullDetail, false),
    ...common(req)
  });

  res.json({ success: true, developerId: devId, count: results.length, results });
}));

app.get("/api/developer/stream", asyncRoute("Falha no iterador de desenvolvedor", async (req, res) => {
  const devId = requiredString(req.query.devId, "devId");
  const maxItems = intP(req.query.maxItems, 100, 1, 250);

  const results = await take(
    live.developerIterator({ devId, ...liveOptions(req, res) }),
    maxItems
  );

  res.json({ success: true, developerId: devId, count: results.length, maxItems, results });
}));

// ---------------- SIMILAR ----------------

app.get("/api/similar/:appId", asyncRoute("Falha ao consultar aplicativos semelhantes", async (req, res) => {
  const appId = appIdP(req.params.appId);

  const results = await cached.similar({
    appId,
    fullDetail: boolP(req.query.fullDetail, false),
    ...common(req)
  });

  res.json({ success: true, appId, count: results.length, results });
}));

// ---------------- REVIEWS ----------------
// As rotas /stream e /all vêm antes da rota genérica por clareza.

app.get("/api/reviews/stream/:appId", asyncRoute("Falha no iterador de avaliações", async (req, res) => {
  const appId = appIdP(req.params.appId);
  const maxItems = intP(req.query.maxItems, 100, 1, 500);
  const score = scoreFilter(req);

  const options = {
    appId,
    sort: enumValue(sort, req.query.sort || "NEWEST", "sort"),
    ...liveOptions(req, res)
  };

  const token = str(req.query.nextPaginationToken);
  if (token) options.nextPaginationToken = token;

  const results = await take(
    live.reviewsIterator(options),
    maxItems,
    score === null ? null : (r) => r.score === score
  );

  res.json({ success: true, appId, count: results.length, maxItems, results });
}));

app.get("/api/reviews/all/:appId", asyncRoute("Falha na coleta de avaliações", async (req, res) => {
  const appId = appIdP(req.params.appId);
  // Limite de 5000 para ficar dentro do timeout do Render.
  const maxReviews = intP(req.query.maxReviews, 500, 1, 5000);
  const score = scoreFilter(req);

  const results = await live.reviewsAll({
    appId,
    maxReviews,
    sort: enumValue(sort, req.query.sort || "NEWEST", "sort"),
    ...liveOptions(req, res)
  });

  const filtered = applyScore(results, score);

  res.json({
    success: true,
    appId,
    count: filtered.length,
    maxReviews,
    scoreFilter: score,
    results: filtered
  });
}));

app.get("/api/reviews/:appId", asyncRoute("Falha ao consultar avaliações", async (req, res) => {
  const appId = appIdP(req.params.appId);
  const score = scoreFilter(req);
  const token = str(req.query.nextPaginationToken);

  const options = {
    appId,
    sort: enumValue(sort, req.query.sort || "NEWEST", "sort"),
    num: intP(req.query.num, 50, 1, 4500),
    paginate: boolP(req.query.paginate, false),
    ...common(req)
  };

  if (token) {
    options.nextPaginationToken = token;
    options.paginate = true;
  }

  const result = await cached.reviews(options);
  const data = applyScore(result.data, score);

  res.json({
    success: true,
    appId,
    count: data.length,
    scoreFilter: score,
    data,
    nextPaginationToken: result.nextPaginationToken ?? null
  });
}));

// ---------------- PERMISSIONS ----------------

app.get("/api/permissions/:appId", asyncRoute("Falha ao consultar permissões", async (req, res) => {
  const appId = appIdP(req.params.appId);

  const results = await cached.permissions({
    appId,
    short: boolP(req.query.short, false),
    ...common(req)
  });

  res.json({ success: true, appId, count: results.length, results });
}));

// ---------------- DATA SAFETY ----------------

app.get("/api/data-safety/:appId", asyncRoute("Falha ao consultar Segurança dos dados", async (req, res) => {
  const appId = appIdP(req.params.appId);

  const data = await cached.dataSafety({ appId, ...common(req) });

  res.json({ success: true, appId, data });
}));

// ---------------- AVAILABILITY ----------------

app.get("/api/availability/:appId", asyncRoute("Falha ao consultar disponibilidade por país", async (req, res) => {
  const appId = appIdP(req.params.appId);

  const countries = str(req.query.countries)
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (countries.length < 1 || countries.length > 50) {
    return fail(
      res, 400,
      "Informe de 1 a 50 países: countries=br,us,de",
      "INVALID_COUNTRIES"
    );
  }

  if (countries.some((c) => !/^[a-z]{2}$/.test(c))) {
    return fail(
      res, 400,
      "Cada país deve ter duas letras (ISO 3166-1 alpha-2).",
      "INVALID_COUNTRIES"
    );
  }

  if (new Set(countries).size !== countries.length) {
    return fail(res, 400, "Não repita códigos de países.", "DUPLICATE_COUNTRIES");
  }

  const lang = str(req.query.lang, "en").toLowerCase();

  if (!/^[a-z]{2}$/.test(lang)) {
    return fail(res, 400, "lang deve conter duas letras.", "INVALID_LOCALE");
  }

  const result = await cached.availability({
    appId,
    countries,
    lang,
    concurrency: intP(req.query.concurrency, 5, 1, 20),
    ...reqTuning(req),
    onIntegrityEvent
  });

  res.json({ success: true, ...result });
}));

// ---------------- CATEGORIES ----------------

app.get("/api/categories", asyncRoute("Falha ao consultar categorias", async (req, res) => {
  const results = await cached.categories({
    ...reqTuning(req),
    onIntegrityEvent
  });

  res.json({ success: true, count: results.length, results });
}));

// ---------------- CONSTANTS ----------------

app.get("/api/constants", (req, res) => {
  res.json({
    success: true,
    collection,
    category,
    sort,
    age,
    permission
  });
});

// ---------------- CACHE ----------------

app.get("/api/cache", (req, res) => {
  res.json({
    success: true,
    cacheSize: cached.cache?.size ?? null,
    maxEntries: CACHE_MAX,
    maxAgeMs: CACHE_TTL_MS
  });
});

app.delete("/api/cache", (req, res) => {
  if (typeof cached.cache?.clear !== "function") {
    return fail(res, 501, "Cache não suporta limpeza nesta versão.", "NOT_SUPPORTED");
  }

  cached.cache.clear();

  res.json({ success: true, message: "Cache limpo." });
});

app.post("/api/cache/invalidate", (req, res) => {
  try {
    const method = str(req.body?.method);
    const options = req.body?.options;

    const allowed = [
      "app",
      "availability",
      "search",
      "suggest",
      "list",
      "categories",
      "developer",
      "similar",
      "reviews",
      "permissions",
      "dataSafety"
    ];

    if (!allowed.includes(method)) {
      return fail(
        res, 400,
        "Método inválido. Use: " + allowed.join(", "),
        "INVALID_CACHE_METHOD"
      );
    }

    if (
      options !== undefined &&
      (typeof options !== "object" || options === null || Array.isArray(options))
    ) {
      return fail(res, 400, "options deve ser um objeto.", "INVALID_CACHE_OPTIONS");
    }

    if (
      method === "categories" &&
      options !== undefined &&
      Object.keys(options).length !== 0
    ) {
      return fail(res, 400, "categories não exige opções.", "INVALID_CACHE_OPTIONS");
    }

    if (typeof cached.cache?.invalidate !== "function") {
      return fail(res, 501, "Cache não suporta invalidação nesta versão.", "NOT_SUPPORTED");
    }

    const invalidated = cached.cache.invalidate(method, options || {});

    res.json({ success: true, method, invalidated });
  } catch (error) {
    handle(res, error, "Falha ao invalidar cache");
  }
});

// =====================================================================
// ASO: análise por cima da biblioteca
// =====================================================================

const STOPWORDS = new Set(
  (
    "a o as os um uma uns umas de do da dos das em no na nos nas por para com sem sob sobre " +
    "e ou mas que se ao aos à às pelo pela pelos pelas este esta isso isto esse essa aquele aquela " +
    "eu você voce vc tu ele ela nós vocês eles elas meu minha seu sua nosso muito mais menos " +
    "já ja não nao sim só so também tambem ser estar ter foi são sao é eh está estou tem tenho têm " +
    "era como quando onde quem qual quais mesmo mesma tudo todo toda todos todas app aplicativo " +
    "the and or but of to in on at for with without from by is are was were be been this that " +
    "these those it its you he she we they my your our not no yes very more less also just can " +
    "will get one use"
  ).split(/\s+/)
);

function tokenize(text) {
  if (typeof text !== "string") return [];

  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(
    (word) =>
      word.length >= 3 && !STOPWORDS.has(word) && !/^\d+$/.test(word)
  );
}

function topTerms(texts, limit, { phrases = false, minCount = 1 } = {}) {
  const counts = new Map();

  for (const text of texts) {
    const tokens = tokenize(text);

    if (phrases) {
      for (let i = 0; i < tokens.length - 1; i++) {
        const key = tokens[i] + " " + tokens[i + 1];
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    } else {
      for (const token of tokens) {
        counts.set(token, (counts.get(token) || 0) + 1);
      }
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term, count]) => ({ term, count }));
}

// Executa fn sobre os itens com no máximo `limit` tarefas simultâneas.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );

  return results;
}

function round(value, digits = 2) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function csvList(value, name, min, max, maxLength = 100) {
  const items = [
    ...new Set(
      str(value)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ];

  if (items.length < min || items.length > max) {
    throw badRequest(
      "Informe de " + min + " a " + max + " itens em " + name + ", separados por vírgula.",
      "INVALID_" + name.toUpperCase()
    );
  }

  if (items.some((item) => item.length > maxLength)) {
    throw badRequest(name + " contém item muito longo.", "PARAMETER_TOO_LONG");
  }

  return items;
}

// ---------------- ASO: RANKING DE KEYWORDS ----------------
// O Google Play entrega cerca de 30 resultados por busca, então
// position = null significa "fora do topo retornado", não "inexistente".

app.get("/api/aso/keyword-rank", asyncRoute("Falha no ranking de keywords", async (req, res) => {
  const appId = appIdP(req.query.appId);
  const keywords = csvList(req.query.keywords, "keywords", 1, 20);
  const num = intP(req.query.num, 50, 1, 250);
  const options = common(req);

  const results = await mapLimit(keywords, 3, async (keyword) => {
    try {
      const list = await cached.search({ term: keyword, num, ...options });
      const index = list.findIndex((item) => item.appId === appId);

      return {
        keyword,
        position: index === -1 ? null : index + 1,
        inTop3: index !== -1 && index < 3,
        inTop10: index !== -1 && index < 10,
        totalResults: list.length,
        top: list.slice(0, 3).map((item, i) => ({
          position: i + 1,
          appId: item.appId,
          title: item.title,
          score: item.score ?? null
        }))
      };
    } catch (error) {
      return { keyword, position: null, error: serializeError(error) };
    }
  });

  const ranked = results.filter((r) => r.position !== null);

  res.json({
    success: true,
    appId,
    summary: {
      keywords: results.length,
      ranked: ranked.length,
      top3: results.filter((r) => r.inTop3).length,
      top10: results.filter((r) => r.inTop10).length,
      failed: results.filter((r) => r.error).length,
      averagePosition: ranked.length
        ? round(ranked.reduce((sum, r) => sum + r.position, 0) / ranked.length, 1)
        : null
    },
    results
  });
}));

// ---------------- ASO: EXPANSÃO POR AUTOCOMPLETE ----------------
// Consulta "termo", "termo a", "termo b"... e pontua pela frequência e
// pela posição das sugestões (posição 1 vale mais que posição 5).

app.get("/api/aso/keyword-expand", asyncRoute("Falha na expansão de keywords", async (req, res) => {
  const term = requiredString(req.query.q, "q").toLowerCase();
  const mode = str(req.query.mode, "alphabet").toLowerCase();
  const depth = intP(req.query.depth, 1, 1, 2);
  const maxQueries = intP(req.query.maxQueries, 40, 1, 150);
  const onlyContaining = boolP(req.query.onlyContaining, false);

  if (!["alphabet", "digits", "both", "none"].includes(mode)) {
    return fail(
      res, 400,
      "mode deve ser alphabet, digits, both ou none.",
      "INVALID_MODE"
    );
  }

  const options = common(req);
  const letters = "abcdefghijklmnopqrstuvwxyz".split("");
  const digits = "0123456789".split("");

  const queries = [term];
  if (mode === "alphabet" || mode === "both") {
    letters.forEach((l) => queries.push(term + " " + l));
  }
  if (mode === "digits" || mode === "both") {
    digits.forEach((d) => queries.push(term + " " + d));
  }

  const found = new Map();
  const failed = [];
  let queriesRun = 0;

  async function run(query) {
    queriesRun++;

    try {
      const list = await cached.suggest({ term: query, ...options });

      list.forEach((raw, index) => {
        const keyword = String(raw).toLowerCase().trim();
        if (!keyword) return;

        const entry = found.get(keyword) || {
          keyword,
          hits: 0,
          score: 0,
          bestPosition: index + 1
        };

        entry.hits += 1;
        entry.score += 5 - index; // posição 1 = 5 pontos ... posição 5 = 1
        entry.bestPosition = Math.min(entry.bestPosition, index + 1);

        found.set(keyword, entry);
      });
    } catch (error) {
      failed.push({ query, error: serializeError(error) });
    }
  }

  await mapLimit(queries.slice(0, maxQueries), 3, run);

  // Nível 2: expande as melhores sugestões encontradas no nível 1.
  if (depth === 2 && queriesRun < maxQueries) {
    const budget = maxQueries - queriesRun;

    const seeds = [...found.values()]
      .filter((e) => e.keyword !== term)
      .sort((a, b) => b.score - a.score)
      .slice(0, budget)
      .map((e) => e.keyword)
      .filter((keyword) => !queries.includes(keyword));

    await mapLimit(seeds, 3, run);
  }

  let keywords = [...found.values()];

  if (onlyContaining) {
    keywords = keywords.filter((e) => e.keyword.includes(term));
  }

  keywords.sort((a, b) => b.score - a.score || b.hits - a.hits);

  res.json({
    success: true,
    seed: term,
    mode,
    depth,
    queriesRun,
    count: keywords.length,
    failedQueries: failed.length,
    failures: failed.slice(0, 5),
    keywords
  });
}));

// ---------------- ASO: COMPARADOR DE CONCORRENTES ----------------

app.get("/api/aso/compare", asyncRoute("Falha na comparação de concorrentes", async (req, res) => {
  const appIds = csvList(req.query.appIds || req.query.ids, "appIds", 2, 10, 200);
  appIds.forEach(appIdP);

  const own = req.query.own ? appIdP(req.query.own) : null;
  const termLimit = intP(req.query.topTerms, 10, 0, 30);

  const raw = await cached.apps({
    appIds,
    concurrency: 5,
    ...common(req)
  });

  const now = Date.now();
  const failed = [];
  const apps = [];

  for (const entry of raw) {
    if (entry.status !== "fulfilled") {
      failed.push({ appId: entry.appId, error: serializeError(entry.error) });
      continue;
    }

    const a = entry.app;
    const histogram = a.histogram || {};
    const totalVotes = Object.values(histogram).reduce(
      (sum, v) => sum + (Number(v) || 0),
      0
    );
    const positive = (Number(histogram[4]) || 0) + (Number(histogram[5]) || 0);
    const negative = (Number(histogram[1]) || 0) + (Number(histogram[2]) || 0);

    const titleSummary = [a.title, a.summary].filter(Boolean).join(" ");

    apps.push({
      appId: a.appId,
      isOwn: a.appId === own,
      title: a.title,
      titleLength: (a.title || "").length,
      summary: a.summary,
      summaryLength: (a.summary || "").length,
      descriptionLength: (a.description || "").length,
      developer: a.developer,
      genre: a.genre,
      score: a.score ?? null,
      ratings: a.ratings ?? null,
      reviews: a.reviews ?? null,
      positiveShare: totalVotes ? round(positive / totalVotes, 3) : null,
      negativeShare: totalVotes ? round(negative / totalVotes, 3) : null,
      installs: a.installs ?? null,
      minInstalls: a.minInstalls ?? null,
      free: a.free,
      price: a.price,
      offersIAP: a.offersIAP,
      adSupported: a.adSupported,
      contentRating: a.contentRating,
      androidVersion: a.androidVersionText ?? a.androidVersion ?? null,
      version: a.version,
      size: a.size ?? null,
      updated: a.updated ? new Date(a.updated).toISOString() : null,
      daysSinceUpdate: a.updated
        ? Math.floor((now - a.updated) / 86400000)
        : null,
      screenshotCount: Array.isArray(a.screenshots) ? a.screenshots.length : 0,
      hasVideo: Boolean(a.video),
      icon: a.icon,
      url: a.url,
      topTerms: termLimit
        ? topTerms(
            [a.title, a.title, a.summary, a.description],
            termLimit
          )
        : [],
      _titleSummaryTerms: [...new Set(tokenize(titleSummary))]
    });
  }

  // Termos que aparecem no título/resumo de 2 ou mais apps.
  const termApps = new Map();
  for (const a of apps) {
    for (const term of a._titleSummaryTerms) {
      termApps.set(term, (termApps.get(term) || 0) + 1);
    }
  }

  const sharedTerms = [...termApps.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([term, count]) => ({ term, apps: count }));

  apps.forEach((a) => delete a._titleSummaryTerms);

  // Comparação contra o seu app.
  const ownApp = apps.find((a) => a.isOwn);

  if (ownApp) {
    for (const a of apps) {
      if (a.isOwn) continue;

      a.vsOwn = {
        scoreDiff:
          a.score !== null && ownApp.score !== null
            ? round(a.score - ownApp.score)
            : null,
        ratingsRatio:
          a.ratings && ownApp.ratings ? round(a.ratings / ownApp.ratings) : null,
        installsRatio:
          a.minInstalls && ownApp.minInstalls
            ? round(a.minInstalls / ownApp.minInstalls)
            : null
      };
    }
  }

  const best = (field, direction = "max") => {
    const valid = apps.filter((a) => typeof a[field] === "number");
    if (!valid.length) return null;

    const winner = valid.reduce((p, c) =>
      direction === "max" ? (c[field] > p[field] ? c : p) : (c[field] < p[field] ? c : p)
    );

    return { appId: winner.appId, title: winner.title, value: winner[field] };
  };

  res.json({
    success: true,
    count: apps.length,
    own,
    leaders: {
      score: best("score"),
      ratings: best("ratings"),
      installs: best("minInstalls"),
      mostRecentlyUpdated: best("daysSinceUpdate", "min")
    },
    sharedTerms,
    apps,
    failed
  });
}));

// ---------------- ASO: ANÁLISE DE AVALIAÇÕES ----------------

app.get("/api/aso/reviews-analysis/:appId", asyncRoute("Falha na análise de avaliações", async (req, res) => {
  const appId = appIdP(req.params.appId);
  // Limite de 3000 para respeitar o timeout do Render.
  const maxReviews = intP(req.query.maxReviews, 500, 1, 3000);
  const sortValue = enumValue(sort, req.query.sort || "NEWEST", "sort");
  const since = str(req.query.since);

  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    return fail(res, 400, "since deve estar no formato YYYY-MM-DD.", "INVALID_DATE");
  }

  let reviews = await live.reviewsAll({
    appId,
    maxReviews,
    sort: sortValue,
    ...liveOptions(req, res)
  });

  if (since) {
    reviews = reviews.filter((r) => typeof r.date === "string" && r.date.slice(0, 10) >= since);
  }

  const total = reviews.length;

  if (total === 0) {
    return res.json({ success: true, appId, total: 0, message: "Nenhuma avaliação encontrada." });
  }

  // Distribuição por nota
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let scoreSum = 0;

  for (const r of reviews) {
    if (distribution[r.score] !== undefined) distribution[r.score]++;
    scoreSum += r.score || 0;
  }

  // Evolução mensal (últimos 12 meses com dados)
  const months = new Map();

  for (const r of reviews) {
    if (typeof r.date !== "string") continue;
    const key = r.date.slice(0, 7);
    const m = months.get(key) || { month: key, count: 0, scoreSum: 0, negative: 0 };
    m.count++;
    m.scoreSum += r.score || 0;
    if (r.score <= 2) m.negative++;
    months.set(key, m);
  }

  const byMonth = [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-12)
    .map((m) => ({
      month: m.month,
      count: m.count,
      averageScore: round(m.scoreSum / m.count),
      negativeShare: round(m.negative / m.count, 3)
    }));

  // Por versão do app (as 10 mais frequentes)
  const versions = new Map();

  for (const r of reviews) {
    const key = r.version || "desconhecida";
    const v = versions.get(key) || { version: key, count: 0, scoreSum: 0 };
    v.count++;
    v.scoreSum += r.score || 0;
    versions.set(key, v);
  }

  const byVersion = [...versions.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map((v) => ({
      version: v.version,
      count: v.count,
      averageScore: round(v.scoreSum / v.count)
    }));

  // Termos e frases em avaliações negativas e positivas
  const negative = reviews.filter((r) => r.score <= 2);
  const positive = reviews.filter((r) => r.score >= 4);

  const negativeTexts = negative.map((r) => r.text);
  const positiveTexts = positive.map((r) => r.text);

  // Respostas do desenvolvedor
  const hasReply = (r) => Boolean(r.replyText || r.replyDate);
  const replied = reviews.filter(hasReply);
  const negativeReplied = negative.filter(hasReply);

  // Avaliações negativas mais úteis (mais "thumbs up")
  const helpfulNegative = [...negative]
    .sort((a, b) => (b.thumbsUp || 0) - (a.thumbsUp || 0))
    .slice(0, 5)
    .map((r) => ({
      id: r.id,
      score: r.score,
      date: r.date,
      version: r.version ?? null,
      thumbsUp: r.thumbsUp || 0,
      text: typeof r.text === "string" ? r.text.slice(0, 300) : null
    }));

  res.json({
    success: true,
    appId,
    analyzed: total,
    since: since || null,
    period: {
      from: reviews.reduce((min, r) => (r.date && r.date < min ? r.date : min), reviews[0].date),
      to: reviews.reduce((max, r) => (r.date && r.date > max ? r.date : max), reviews[0].date)
    },
    averageScore: round(scoreSum / total),
    distribution,
    distributionShare: Object.fromEntries(
      Object.entries(distribution).map(([score, count]) => [score, round(count / total, 3)])
    ),
    byMonth,
    byVersion,
    negative: {
      count: negative.length,
      share: round(negative.length / total, 3),
      topTerms: topTerms(negativeTexts, 20),
      topPhrases: topTerms(negativeTexts, 15, { phrases: true, minCount: 2 }),
      mostHelpful: helpfulNegative
    },
    positive: {
      count: positive.length,
      share: round(positive.length / total, 3),
      topTerms: topTerms(positiveTexts, 20),
      topPhrases: topTerms(positiveTexts, 15, { phrases: true, minCount: 2 })
    },
    developerReplies: {
      replied: replied.length,
      replyRate: round(replied.length / total, 3),
      negativeReplyRate: negative.length
        ? round(negativeReplied.length / negative.length, 3)
        : null
    }
  });
}));

// ---------------- MÉTRICAS ----------------

app.get("/api/metrics", (req, res) => {
  res.json({
    success: true,
    proxyEnabled: Boolean(FETCH_IMPL),
    ...metrics,
    averageLatencyMs: metrics.responses
      ? Math.round(metrics.totalLatencyMs / metrics.responses)
      : null
  });
});

// ---------------- DIAGNÓSTICO ----------------

app.get("/api/diagnostics", asyncRoute("Falha ao ler diagnósticos", async (req, res) => {
  const limit = intP(req.query.limit, 50, 1, DIAG_MAX);

  res.json({
    success: true,
    count: Math.min(limit, diagnostics.length),
    events: diagnostics.slice(-limit).reverse()
  });
}));

// ---------------- INVENTÁRIO DA BIBLIOTECA ----------------

app.get("/api/library", (req, res) => {
  const exports = Object.keys(gplay)
    .sort()
    .map((name) => ({ name, type: typeof gplay[name] }));

  res.json({
    success: true,
    library: "@mradex77/google-play-scraper",
    count: exports.length,
    exports
  });
});

// ---------------- ROTAS DESCONHECIDAS ----------------

app.use((req, res) => {
  fail(res, 404, "Rota não encontrada.", "ROUTE_NOT_FOUND");
});

// ---------------- ERROR HANDLER GLOBAL ----------------

app.use((error, req, res, next) => {
  console.error("Erro não tratado:", error);

  if (res.headersSent) return next(error);

  handle(res, error, "Erro interno do servidor");
});

// ---------------- START ----------------

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("Google Play ASO API online na porta " + PORT);
});

// Evita 502 intermitente atrás do proxy do Render.
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;

process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM recebido, encerrando...");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
});
