
import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";

import {
  memoized,
  collection,
  category,
  sort,
  device,
  age,
  permission
} from "@mradex77/google-play-scraper";

const app = express();
const PORT = process.env.PORT || 10000;


app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(helmet());
app.use(express.json({ limit: "20kb" }));

const client = memoized({
  lang: "pt",
  country: "br",
  throttle: 3,
  maxAgeMs: 5 * 60 * 1000,
  max: 500,
  requestOptions: {
    timeoutMs: 30000,
    retries: 2
  }
});

const routes = [
  "GET /",
  "GET /health",
  "GET /api/search",
  "GET /api/search/stream",
  "GET /api/app/:appId",
  "GET /api/apps",
  "GET /api/suggest",
  "GET /api/list",
  "GET /api/developer",
  "GET /api/developer/stream",
  "GET /api/similar/:appId",
  "GET /api/reviews/:appId",
  "GET /api/reviews/stream/:appId",
  "GET /api/reviews/all/:appId",
  "GET /api/permissions/:appId",
  "GET /api/data-safety/:appId",
  "GET /api/availability/:appId",
  "GET /api/categories",
  "GET /api/constants",
  "GET /api/cache",
  "DELETE /api/cache",
  "POST /api/cache/invalidate"
];

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api", limiter);

// ---------------- HELPERS ----------------

function fail(res, status, message, code) {
  return res.status(status).json({
    success: false,
    error: message,
    code: code
  });
}

function str(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  return value.trim();
}

function intP(value, fallback, min, max) {
  if (value === undefined || value === "") {
    return fallback;
  }

  const n = Number(value);

  if (!Number.isInteger(n) || n < min || n > max) {
    const error = new Error(
      "Número deve estar entre " + min + " e " + max
    );

    error.status = 400;
    error.code = "INVALID_NUMBER";

    throw error;
  }

  return n;
}

function boolP(value, fallback = false) {
  if (value === undefined || value === "") {
    return fallback;
  }

  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;

  const error = new Error(
    "Valor booleano inválido. Use true ou false."
  );

  error.status = 400;
  error.code = "INVALID_BOOLEAN";

  throw error;
}

function locale(req) {
  const country = str(req.query.country, "br").toLowerCase();
  const lang = str(req.query.lang, "pt").toLowerCase();

  if (
    !/^[a-z]{2}$/.test(country) ||
    !/^[a-z]{2}$/.test(lang)
  ) {
    const error = new Error(
      "country e lang devem conter duas letras."
    );

    error.status = 400;
    error.code = "INVALID_LOCALE";

    throw error;
  }

  return { country, lang };
}

function requiredString(value, name) {
  const result = str(value);

  if (!result) {
    const error = new Error(name + " obrigatório.");
    error.status = 400;
    error.code = "MISSING_PARAMETER";
    throw error;
  }

  return result;
}

function handle(res, error, fallback) {
  console.error(fallback, error);

  let status = error.status || 502;

  if (error.name === "ValidationError") status = 400;
  if (error.name === "NotFoundError") status = 404;
  if (error.name === "RateLimitError") status = 429;
  if (error.name === "BlockedError") status = 503;

  return fail(
    res,
    status,
    status === 400 || status === 404
      ? error.message
      : fallback,
    error.code || error.name || "SCRAPER_ERROR"
  );
}

function asyncRoute(fallback, callback) {
  return async (req, res) => {
    try {
      await callback(req, res);
    } catch (error) {
      if (!res.headersSent) {
        handle(res, error, fallback);
      }
    }
  };
}

function enumValue(source, value, name) {
  const key = str(value).toUpperCase();
  const result = source[key];

  if (result === undefined) {
    const error = new Error(
      name + " inválido. Valores: " +
      Object.keys(source).join(", ")
    );

    error.status = 400;
    error.code = "INVALID_ENUM";

    throw error;
  }

  return result;
}

function getReviewOptions(req) {
  const { country, lang } = locale(req);

  const options = {
    country,
    lang,
    num: intP(req.query.num, 50, 1, 4500),
    sort: enumValue(sort, req.query.sort || "NEWEST", "sort"),
    paginate: boolP(req.query.paginate, false)
  };

  if (req.query.score !== undefined) {
    options.score = intP(req.query.score, undefined, 1, 5);
  }

  if (req.query.device !== undefined) {
    options.device = enumValue(
      device,
      req.query.device,
      "device"
    );
  }

  if (req.query.nextPaginationToken !== undefined) {
    options.nextPaginationToken = str(
      req.query.nextPaginationToken
    );
  }

  if (req.query.pageSize !== undefined) {
    options.pageSize = intP(
      req.query.pageSize,
      150,
      1,
      4500
    );
  }

  return options;
}

// ---------------- AUTH ----------------



// ---------------- PUBLIC INFO ----------------

app.get("/", (req, res) => {
  res.json({
    success: true,
    name: "Google Play ASO API",
    version: "3.0.0",
    library: "@mradex77/google-play-scraper",
    node: process.version,
    endpoints: routes
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "ok",
    timestamp: new Date().toISOString()
  });
});

// ---------------- SEARCH ----------------

app.get("/api/search", asyncRoute(
  "Falha na pesquisa",
  async (req, res) => {
    const term = requiredString(req.query.q, "q");
    const { country, lang } = locale(req);

    const price = str(req.query.price, "all").toLowerCase();

    if (!["all", "free", "paid"].includes(price)) {
      return fail(
        res, 400,
        "price deve ser all, free ou paid.",
        "INVALID_PRICE"
      );
    }

    const results = await client.search({
      term,
      country,
      lang,
      num: intP(req.query.num, 20, 1, 250),
      price,
      fullDetail: boolP(req.query.fullDetail, false)
    });

    res.json({
      success: true,
      query: term,
      count: results.length,
      results
    });
  }
));

// ---------------- APP DETAILS ----------------

app.get("/api/app/:appId", asyncRoute(
  "Falha ao obter detalhes do aplicativo",
  async (req, res) => {
    const { country, lang } = locale(req);

    const data = await client.app({
      appId: req.params.appId,
      country,
      lang
    });

    res.json({
      success: true,
      data
    });
  }
));

// ---------------- BATCH APPS ----------------

app.get("/api/apps", asyncRoute(
  "Falha na consulta em lote",
  async (req, res) => {
    const idsText = requiredString(
      req.query.appIds || req.query.ids,
      "appIds"
    );

    const appIds = idsText.split(",").map(
      id => id.trim()
    );

    if (
      appIds.length < 1 ||
      appIds.length > 250 ||
      appIds.some(id => !id)
    ) {
      return fail(
        res, 400,
        "Informe de 1 a 250 IDs separados por vírgula.",
        "INVALID_APP_IDS"
      );
    }

    const { country, lang } = locale(req);

    const results = await client.apps({
      appIds,
      concurrency: intP(req.query.concurrency, 5, 1, 20),
      country,
      lang
    });

    res.json({
      success: true,
      count: results.length,
      succeeded: results.filter(
        item => item.status === "fulfilled"
      ).length,
      failed: results.filter(
        item => item.status === "rejected"
      ).length,
      results
    });
  }
));

// ---------------- SEARCH SUGGESTIONS ----------------

app.get("/api/suggest", asyncRoute(
  "Falha nas sugestões",
  async (req, res) => {
    const term = requiredString(req.query.q, "q");
    const { country, lang } = locale(req);

    const results = await client.suggest({
      term,
      country,
      lang
    });

    res.json({
      success: true,
      query: term,
      count: results.length,
      results
    });
  }
));

// ---------------- TOP CHARTS / LIST ----------------

app.get("/api/list", asyncRoute(
  "Falha ao obter rankings",
  async (req, res) => {
    const { country, lang } = locale(req);

    const collectionName = str(
      req.query.collection,
      "TOP_FREE"
    ).toUpperCase();

    const categoryName = str(
      req.query.category,
      "APPLICATION"
    ).toUpperCase();

    const options = {
      collection: enumValue(
        collection, collectionName, "collection"
      ),
      category: enumValue(
        category, categoryName, "category"
      ),
      country,
      lang,
      num: intP(req.query.num, 30, 1, 500),
      fullDetail: boolP(req.query.fullDetail, false)
    };

    if (req.query.age !== undefined) {
      options.age = enumValue(age, req.query.age, "age");
    }

    const results = await client.list(options);

    res.json({
      success: true,
      collection: collectionName,
      category: categoryName,
      count: results.length,
      results
    });
  }
));

// ---------------- DEVELOPER ----------------

app.get("/api/developer", asyncRoute(
  "Falha ao consultar desenvolvedor",
  async (req, res) => {
    const devId = requiredString(req.query.devId, "devId");
    const { country, lang } = locale(req);

    const results = await client.developer({
      devId,
      country,
      lang,
      num: intP(req.query.num, 60, 1, 500),
      fullDetail: boolP(req.query.fullDetail, false)
    });

    res.json({
      success: true,
      developerId: devId,
      count: results.length,
      results
    });
  }
));

// ---------------- SIMILAR APPS ----------------

app.get("/api/similar/:appId", asyncRoute(
  "Falha ao consultar aplicativos semelhantes",
  async (req, res) => {
    const { country, lang } = locale(req);

    const results = await client.similar({
      appId: req.params.appId,
      country,
      lang,
      fullDetail: boolP(req.query.fullDetail, false)
    });

    res.json({
      success: true,
      appId: req.params.appId,
      count: results.length,
      results
    });
  }
));

// ---------------- REVIEWS ----------------

app.get("/api/reviews/:appId", asyncRoute(
  "Falha ao consultar avaliações",
  async (req, res) => {
    const options = getReviewOptions(req);

    const result = await client.reviews({
      appId: req.params.appId,
      ...options
    });

    res.json({
      success: true,
      appId: req.params.appId,
      count: result.data.length,
      data: result.data,
      nextPaginationToken: result.nextPaginationToken
    });
  }
));

// ---------------- REVIEW ITERATOR ----------------
// Coleta incremental, limitada por maxItems.

app.get("/api/reviews/stream/:appId", asyncRoute(
  "Falha no iterador de avaliações",
  async (req, res) => {
    const options = getReviewOptions(req);
    const maxItems = intP(req.query.maxItems, 100, 1, 500);

    const iterator = client.reviewsIterator({
      appId: req.params.appId,
      ...options,
      // O iterador trabalha página a página.
      // maxItems é aplicado pelo servidor.
      paginate: undefined,
      num: undefined
    });

    const results = [];

    for await (const item of iterator) {
      results.push(item);

      if (results.length >= maxItems) break;
    }

    res.json({
      success: true,
      appId: req.params.appId,
      count: results.length,
      maxItems,
      results
    });
  }
));

// ---------------- ALL REVIEWS (BOUNDED) ----------------

app.get("/api/reviews/all/:appId", asyncRoute(
  "Falha na coleta de avaliações",
  async (req, res) => {
    const maxReviews = intP(
      req.query.maxReviews,
      500,
      1,
      10000
    );

    const { country, lang } = locale(req);
    const sortValue = enumValue(
      sort, req.query.sort || "NEWEST", "sort"
    );

    const options = {
      appId: req.params.appId,
      country,
      lang,
      sort: sortValue,
      maxReviews,
      pageSize: intP(req.query.pageSize, 150, 1, 4500)
    };

    if (req.query.score !== undefined) {
      options.score = intP(req.query.score, undefined, 1, 5);
    }

    if (req.query.device !== undefined) {
      options.device = enumValue(
        device, req.query.device, "device"
      );
    }

    const results = await client.reviewsAll(options);

    res.json({
      success: true,
      appId: req.params.appId,
      count: results.length,
      maxReviews,
      results
    });
  }
));

// ---------------- SEARCH ITERATOR ----------------

app.get("/api/search/stream", asyncRoute(
  "Falha no iterador de pesquisa",
  async (req, res) => {
    const term = requiredString(req.query.q, "q");
    const { country, lang } = locale(req);
    const maxItems = intP(req.query.maxItems, 100, 1, 250);

    const iterator = client.searchIterator({
      term,
      country,
      lang
    });

    const results = [];

    for await (const item of iterator) {
      results.push(item);
      if (results.length >= maxItems) break;
    }

    res.json({
      success: true,
      query: term,
      count: results.length,
      maxItems,
      results
    });
  }
));

// ---------------- DEVELOPER ITERATOR ----------------

app.get("/api/developer/stream", asyncRoute(
  "Falha no iterador de desenvolvedor",
  async (req, res) => {
    const devId = requiredString(req.query.devId, "devId");
    const { country, lang } = locale(req);
    const maxItems = intP(req.query.maxItems, 100, 1, 250);

    const iterator = client.developerIterator({
      devId,
      country,
      lang
    });

    const results = [];

    for await (const item of iterator) {
      results.push(item);
      if (results.length >= maxItems) break;
    }

    res.json({
      success: true,
      developerId: devId,
      count: results.length,
      maxItems,
      results
    });
  }
));

// ---------------- PERMISSIONS ----------------

app.get("/api/permissions/:appId", asyncRoute(
  "Falha ao consultar permissões",
  async (req, res) => {
    const { country, lang } = locale(req);

    const results = await client.permissions({
      appId: req.params.appId,
      country,
      lang,
      short: boolP(req.query.short, false)
    });

    res.json({
      success: true,
      appId: req.params.appId,
      count: results.length,
      results
    });
  }
));

// ---------------- DATA SAFETY ----------------

app.get("/api/data-safety/:appId", asyncRoute(
  "Falha ao consultar Segurança dos dados",
  async (req, res) => {
    const { country, lang } = locale(req);

    const data = await client.dataSafety({
      appId: req.params.appId,
      country,
      lang
    });

    res.json({
      success: true,
      appId: req.params.appId,
      data
    });
  }
));

// ---------------- COUNTRY AVAILABILITY ----------------

app.get("/api/availability/:appId", asyncRoute(
  "Falha ao consultar disponibilidade por país",
  async (req, res) => {
    const countries = str(
      req.query.countries
    ).split(",").map(
      value => value.trim().toLowerCase()
    ).filter(Boolean);

    if (countries.length < 1 || countries.length > 50) {
      return fail(
        res, 400,
        "Informe de 1 a 50 países: countries=br,us,de",
        "INVALID_COUNTRIES"
      );
    }

    const uniqueCountries = new Set(countries);

    if (uniqueCountries.size !== countries.length) {
      return fail(
        res, 400,
        "Não repita códigos de países.",
        "DUPLICATE_COUNTRIES"
      );
    }

    const lang = str(req.query.lang, "en").toLowerCase();

    if (!/^[a-z]{2}$/.test(lang)) {
      return fail(
        res, 400,
        "lang deve conter duas letras.",
        "INVALID_LOCALE"
      );
    }

    const result = await client.availability({
      appId: req.params.appId,
      countries,
      lang,
      concurrency: intP(
        req.query.concurrency, 5, 1, 20
      )
    });

    res.json({
      success: true,
      ...result
    });
  }
));

// ---------------- CATEGORY TAXONOMY ----------------

app.get("/api/categories", asyncRoute(
  "Falha ao consultar categorias",
  async (req, res) => {
    const results = await client.categories();

    res.json({
      success: true,
      count: results.length,
      results
    });
  }
));

// ---------------- CONSTANTS ----------------

app.get("/api/constants", (req, res) => {
  res.json({
    success: true,
    collection,
    category,
    sort,
    device,
    age,
    permission
  });
});

// ---------------- CACHE STATUS ----------------

app.get("/api/cache", (req, res) => {
  res.json({
    success: true,
    cacheSize: client.cache.size,
    maxEntries: 500,
    maxAgeMs: 300000
  });
});

// ---------------- CLEAR CACHE ----------------

app.delete("/api/cache", (req, res) => {
  client.cache.clear();

  res.json({
    success: true,
    message: "Cache limpo."
  });
});

// ---------------- INVALIDATE ONE CACHE ENTRY ----------------

app.post("/api/cache/invalidate", (req, res) => {
  try {
    const method = str(req.body.method);
    const options = req.body.options;

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
      method === "categories" &&
      options !== undefined &&
      Object.keys(options).length !== 0
    ) {
      return fail(
        res, 400,
        "categories não exige opções.",
        "INVALID_CACHE_OPTIONS"
      );
    }

    const invalidated = client.cache.invalidate(
      method,
      options || {}
    );

    res.json({
      success: true,
      method,
      invalidated
    });
  } catch (error) {
    handle(res, error, "Falha ao invalidar cache");
  }
});

// ---------------- UNKNOWN ROUTES ----------------

app.use((req, res) => {
  fail(
    res,
    404,
    "Rota não encontrada.",
    "ROUTE_NOT_FOUND"
  );
});

// ---------------- GLOBAL ERROR HANDLER ----------------

app.use((error, req, res, next) => {
  console.error("Erro não tratado:", error);

  if (res.headersSent) return next(error);

  handle(res, error, "Erro interno do servidor");
});

// ---------------- START ----------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    "Google Play ASO API online na porta " + PORT
  );
});
