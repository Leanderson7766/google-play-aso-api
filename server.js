import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import {
  createClient,
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
const API_KEY = process.env.ASO_API_KEY || "";

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet());
app.use(express.json({ limit: "20kb" }));

// Cliente compartilhado - resolve 90% dos 429 e bloqueios
const client = memoized({
  lang: 'pt',
  country: 'br',
  throttle: 3, // 3 req/s no total, não por chamada
  maxAgeMs: 5 * 60 * 1000,
  max: 500
});

const limiter = rateLimit({ windowMs: 60*1000, limit: 60, standardHeaders: true, legacyHeaders: false });
app.use("/api", limiter);

// ---- helpers ----
const fail = (res, status, msg, code) => res.status(status).json({ success: false, error: msg, code });
const p = (v, d) => typeof v === 'string'? v.trim() : d;
const intP = (v, d, min, max) => {
  if (v === undefined || v === "") return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) { const e = new Error("Num fora do intervalo"); e.status=400; e.code="INVALID_NUMBER"; throw e; }
  return n;
}
const boolP = (v, d) => v === undefined? d : v === "true"? true : v === "false"? false : (()=>{ const e=new Error("Bool inválido"); e.status=400; throw e; })();
const locale = (req) => {
  const country = p(req.query.country, 'br').toLowerCase();
  const lang = p(req.query.lang, 'pt').toLowerCase();
  if (!/^[a-z]{2}$/.test(country) ||!/^[a-z]{2}$/.test(lang)) { const e=new Error("country/lang 2 letras"); e.status=400; throw e; }
  return { country, lang };
}
const handle = (res, err, fallback) => {
  console.error(fallback, err);
  const status = err.status || (err.name === 'ValidationError'? 400 : err.name === 'NotFoundError'? 404 : 502);
  return fail(res, status, status===400||status===404? err.message : fallback, err.code || err.name || "SCRAPER_ERROR");
}

// ---- auth ----
app.use("/api", (req, res, next) => {
  if (!API_KEY) return next();
  if ((req.get("x-api-key")||"")!== API_KEY) return fail(res, 401, "Chave inválida", "UNAUTHORIZED");
  next();
});

app.get("/", (req,res)=> res.json({ success:true, name:"Google Play ASO API", version:"2.1.0", endpoints:["/health","/api/search?q=","/api/app/:appId","/api/apps?appIds=","/api/suggest?q=","/api/list?collection=TOP_FREE&category=APPLICATION","/api/developer?devId=","/api/similar/:appId","/api/reviews/:appId","/api/permissions/:appId","/api/data-safety/:appId","/api/availability/:appId?countries=br,us","/api/categories"] }));
app.get("/health", (req,res)=> res.json({ success:true, status:"ok" }));

// SEARCH
app.get("/api/search", async (req,res)=>{
  try{
    const term=p(req.query.q,""); if(!term) return fail(res,400,"q obrigatório","INVALID_QUERY");
    const {country, lang}=locale(req);
    const num=intP(req.query.num,20,1,250);
    const results=await client.search({ term, country, lang, num, price: p(req.query.price,'all'), fullDetail: boolP(req.query.fullDetail,false) });
    res.json({ success:true, count:results.length, results });
  }catch(e){ handle(res,e,"Falha na pesquisa") }
});

// APP SINGLE
app.get("/api/app/:appId", async (req,res)=>{
  try{
    const {country, lang}=locale(req);
    const data=await client.app({ appId: req.params.appId, country, lang });
    res.json({ success:true, data });
  }catch(e){ handle(res,e,"Falha ao obter detalhes") }
});

// APPS BATCH - aqui estava seu maior erro, o método certo é `apps` com appIds[]
app.get("/api/apps", async (req,res)=>{
  try{
    const idsText=p(req.query.appIds || req.query.ids,""); if(!idsText) return fail(res,400,"Use?appIds=com.a,com.b","MISSING_IDS");
    const appIds=[...new Set(idsText.split(",").map(s=>s.trim()).filter(Boolean))].slice(0,50);
    const {country, lang}=locale(req);
    const result=await client.apps({ appIds, concurrency: intP(req.query.concurrency,5,1,20), lang: lang, country: country });
    // result já vem no formato {status, appId, app/error}
    res.json({ success:true, count:result.length, results: result });
  }catch(e){ handle(res,e,"Falha em lote") }
});

app.get("/api/suggest", async (req,res)=>{
  try{
    const term=p(req.query.q,""); if(!term) return fail(res,400,"q obrigatório","INVALID_QUERY");
    const {country, lang}=locale(req);
    const results=await client.suggest({ term, country, lang });
    res.json({ success:true, query:term, results });
  }catch(e){ handle(res,e,"Falha suggest") }
});

app.get("/api/list", async (req,res)=>{
  try{
    const {country, lang}=locale(req);
    const colName=p(req.query.collection,"TOP_FREE").toUpperCase();
    const catName=p(req.query.category,"APPLICATION").toUpperCase();
    const col=collection[colName]; if(!col) return fail(res,400,`collection inválida. Use: ${Object.keys(collection).join(", ")}`,"INVALID_COLLECTION");
    const cat=category[catName]; if(!cat) return fail(res,400,`category inválida. Use: ${Object.keys(category).join(", ")}`,"INVALID_CATEGORY");
    const results=await client.list({ collection: col, category: cat, age: req.query.age? age[p(req.query.age,"").toUpperCase()] : undefined, country, lang, num:intP(req.query.num,30,1,200), fullDetail: boolP(req.query.fullDetail,false) });
    res.json({ success:true, collection:colName, category:catName, count:results.length, results });
  }catch(e){ handle(res,e,"Falha list") }
});

app.get("/api/developer", async (req,res)=>{
  try{
    const devId=p(req.query.devId,""); if(!devId) return fail(res,400,"devId obrigatório","INVALID_DEVELOPER");
    const {country, lang}=locale(req);
    const results=await client.developer({ devId, country, lang, num:intP(req.query.num,60,1,500), fullDetail: boolP(req.query.fullDetail,false) });
    res.json({ success:true, developerId:devId, count:results.length, results });
  }catch(e){ handle(res,e,"Falha developer") }
});

app.get("/api/similar/:appId", async (req,res)=>{
  try{
    const {country, lang}=locale(req);
    const results=await client.similar({ appId:req.params.appId, country, lang, fullDetail: boolP(req.query.fullDetail,false) });
    res.json({ success:true, appId:req.params.appId, count:results.length, results });
  }catch(e){ handle(res,e,"Falha similar") }
});

app.get("/api/reviews/:appId", async (req,res)=>{
  try{
    const {country, lang}=locale(req);
    const sortName=p(req.query.sort,"NEWEST").toUpperCase();
    const s=sort[sortName]; if(!s) return fail(res,400,"sort: NEWEST, RATING, HELPFULNESS","INVALID_SORT");
    const devName=req.query.device? p(req.query.device,"").toUpperCase() : null;
    const dev=devName? device[devName] : undefined;
    if(devName &&!dev) return fail(res,400,"device: MOBILE, TABLET, WATCH, CHROMEBOOK, TV","INVALID_DEVICE");

    const result=await client.reviews({
      appId:req.params.appId, country, lang,
      num:intP(req.query.num,50,1,4500),
      sort:s,
      score: req.query.score? intP(req.query.score,undefined,1,5) : undefined,
      device: dev,
      paginate: boolP(req.query.paginate,false),
      nextPaginationToken: p(req.query.nextPaginationToken,"") || undefined,
      pageSize: req.query.pageSize? intP(req.query.pageSize,150,1,4500) : undefined
    });
    res.json({ success:true, appId:req.params.appId, count:result.data.length,...result });
  }catch(e){ handle(res,e,"Falha reviews") }
});

// ESSAS 4 ESTAVAM FALTANDO / QUEBRADAS
app.get("/api/permissions/:appId", async (req,res)=>{
  try{
    const {country, lang}=locale(req);
    const results=await client.permissions({ appId:req.params.appId, country, lang, short: boolP(req.query.short,false) });
    res.json({ success:true, appId:req.params.appId, count:results.length, results });
  }catch(e){ handle(res,e,"Falha permissions") }
});

app.get("/api/data-safety/:appId", async (req,res)=>{
  try{
    const {country, lang}=locale(req);
    const result=await client.dataSafety({ appId:req.params.appId, country, lang });
    res.json({ success:true, appId:req.params.appId, data: result });
  }catch(e){ handle(res,e,"Falha dataSafety") }
});

app.get("/api/availability/:appId", async (req,res)=>{
  try{
    const countries=(p(req.query.countries,"")||"").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
    if(!countries.length) return fail(res,400,"Use?countries=br,us,de","MISSING_COUNTRIES");
    const lang=p(req.query.lang,"en");
    const result=await client.availability({ appId:req.params.appId, countries, lang, concurrency:intP(req.query.concurrency,5,1,20) });
    res.json({ success:true,...result });
  }catch(e){ handle(res,e,"Falha availability") }
});

app.get("/api/categories", async (req,res)=>{
  try{
    const results=await client.categories();
    res.json({ success:true, count:results.length, results });
  }catch(e){ handle(res,e,"Falha categories") }
});

app.listen(PORT, ()=> console.log(`ASO API online na porta ${PORT}`));
