
const express = require("express");
const gplay = require("@mradex77/google-play-scraper").default;

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));

// Teste de disponibilidade da API
app.get("/", (req, res) => {
  res.json({
    success: true,
    name: "Google Play ASO API",
    version: "1.0.0",
    status: "online"
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "ok"
  });
});

// Pesquisa aplicativos na Google Play
app.get("/api/search", async (req, res) => {
  const term = String(req.query.q || "").trim();
  const country = String(req.query.country || "br").toLowerCase();
  const lang = String(req.query.lang || "pt").toLowerCase();

  const requestedNum = Number(req.query.num || 10);
  const num = Number.isFinite(requestedNum)
    ? Math.max(1, Math.min(30, Math.floor(requestedNum)))
    : 10;

  if (!term || term.length > 150) {
    return res.status(400).json({
      success: false,
      error: "Informe q com uma palavra-chave válida."
    });
  }

  if (!/^[a-z]{2}$/.test(country) ||
      !/^[a-z]{2}$/.test(lang)) {
    return res.status(400).json({
      success: false,
      error: "country e lang devem ter dois caracteres."
    });
  }

  try {
    const results = await gplay.search({
      term: term,
      country: country,
      lang: lang,
      num: num
    });

    res.json({
      success: true,
      query: term,
      country: country,
      count: results.length,
      results: results
    });
  } catch (error) {
    console.error("Erro na pesquisa:", error);

    res.status(502).json({
      success: false,
      error: "Não foi possível consultar a Google Play.",
      code: error.name || "SCRAPER_ERROR"
    });
  }
});

// Detalhes de um aplicativo pelo package name
app.get("/api/app/:appId", async (req, res) => {
  const appId = String(req.params.appId || "").trim();

  if (!/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/.test(appId)) {
    return res.status(400).json({
      success: false,
      error: "Identificador de aplicativo inválido."
    });
  }

  try {
    const details = await gplay.app({
      appId: appId,
      country: "br",
      lang: "pt"
    });

    res.json({
      success: true,
      data: details
    });
  } catch (error) {
    console.error("Erro nos detalhes:", error);

    res.status(502).json({
      success: false,
      error: "Não foi possível obter os detalhes do aplicativo.",
      code: error.name || "SCRAPER_ERROR"
    });
  }
});

// Resposta para rotas inexistentes
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint não encontrado."
  });
});

// Tratamento de erros inesperados do Express
app.use((err, req, res, next) => {
  console.error("Erro HTTP:", err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    success: false,
    error: "Erro interno do servidor."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Google Play ASO API iniciada na porta " + PORT);
});
        
