import express from 'express'; import cors from 'cors'; import helmet from 'helmet'; import rateLimit from 'express-rate-limit'; import multer from 'multer'; import AdmZip from 'adm-zip'; import mammoth from 'mammoth'; import pdf from 'pdf-parse';
const app=express(), upload=multer({storage:multer.memoryStorage(),limits:{fileSize:50*1024*1024,files:150}}); const PORT=process.env.PORT||8787;
const cleanOrigin=x=>String(x||'').trim().replace(/\/+$/,''); const origins=[...new Set(['https://zayaiken21.github.io',...(process.env.ALLOWED_ORIGINS||'').split(',')].map(cleanOrigin).filter(Boolean))];
const corsOptions={origin:(origin,cb)=>{if(!origin||origins.includes(cleanOrigin(origin)))return cb(null,true);console.warn('Blocked CORS origin:',origin);cb(null,false)},methods:['GET','POST','OPTIONS'],allowedHeaders:['Content-Type','Authorization','Cache-Control'],optionsSuccessStatus:204};
app.use(helmet({crossOriginResourcePolicy:false}));app.use(cors(corsOptions));app.options(/.*/,cors(corsOptions));app.use(express.json({limit:'15mb'}));app.use(rateLimit({windowMs:60000,limit:180}));
const normalizeWpUrl=value=>{let v=String(value||'').trim();if(!v)return'';if(!/^https?:\/\//i.test(v))v='https://'+v;const u=new URL(v);return `${u.protocol}//${u.host}${u.pathname.replace(/\/(wp-admin|wp-login\.php|wp-json).*$/i,'').replace(/\/$/,'')}`};
const authHeader=w=>`Basic ${Buffer.from(`${w.username}:${String(w.appPassword||'').replace(/\s+/g,'')}`).toString('base64')}`; const parseBody=async r=>{const t=await r.text();try{return t?JSON.parse(t):{}}catch{return{raw:t}}}; const fetchTimed=(url,opts={},ms=20000)=>fetch(url,{...opts,signal:AbortSignal.timeout(ms),redirect:'follow'});
async function discoverWp(w){const site=normalizeWpUrl(w.url);if(!site)throw Object.assign(new Error('Enter your WordPress Site URL.'),{code:'missing_site'});let discovered='';try{const h=await fetchTimed(site,{method:'HEAD'});const m=(h.headers.get('link')||'').match(/<([^>]+)>;\s*rel=["']?https:\/\/api\.w\.org\/["']?/i);if(m)discovered=m[1]}catch{}for(const root of [discovered,`${site}/wp-json/`,`${site}/?rest_route=/`].filter(Boolean).filter((x,i,a)=>a.indexOf(x)===i)){try{const r=await fetchTimed(root,{headers:{Accept:'application/json'}}),j=await parseBody(r);if(r.ok&&(j.namespaces?.includes?.('wp/v2')||j.routes&&Object.keys(j.routes).some(k=>k.startsWith('/wp/v2'))))return{site,root:root.endsWith('/')?root:root+'/'}}catch{}}throw Object.assign(new Error('WordPress REST API was not found. Re-save Settings → Permalinks and check security/cache plugins.'),{code:'rest_not_found'})}
const routeUrl=(root,path)=>root.includes('?rest_route=')?`${root}${encodeURI(path.replace(/^\/?/,'wp/v2/'))}`:`${root}wp/v2/${path.replace(/^\//,'')}`;
async function wpFetch(w,path,opts={}){const d=w.restRoot?{root:w.restRoot}:await discoverWp(w),url=routeUrl(d.root,path);const r=await fetchTimed(url,{...opts,headers:{Accept:'application/json',Authorization:authHeader(w),...(opts.headers||{})}},30000),j=await parseBody(r);if(!r.ok)throw Object.assign(new Error(j.message||`WordPress returned ${r.status}`),{status:r.status,wpCode:j.code,url});return j}
function wpError(e){let message=e.message||'WordPress connection failed.';if(e.status===401||['rest_not_logged_in','incorrect_password','invalid_username'].includes(e.wpCode))message='WordPress authentication failed. Use your WordPress login username and the generated Application Password.';else if(e.status===403)message='WordPress blocked access. Check the user role/capabilities and security rules.';else if(e.status===404||e.wpCode==='rest_no_route')message='WordPress REST route was not found.';return{error:message,code:e.wpCode||e.code||'wordpress_error',status:e.status||400,url:e.url||null}}
const slug=s=>String(s||'').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g,'').trim().replace(/[\s_]+/g,'-').replace(/-+/g,'-');
const arr=v=>Array.isArray(v)?v:String(v||'').split(/[|;]/).map(x=>x.trim()).filter(Boolean); const pick=(o,...ks)=>{for(const k of ks)if(o?.[k]!=null&&o[k]!=='')return o[k];return''};
function normalizeSection(s){if(!s||typeof s!=='object')return null;const type=String(s.type||'paragraph').toLowerCase();if(type==='heading')return{type,level:Number(s.level)||2,content:pick(s,'content','text','title')};if(type==='image')return{type,filename:pick(s,'filename','file','name'),alt_text:pick(s,'alt_text','alt'),prompt:s.prompt||'',caption:s.caption||'',purpose:s.purpose||''};if(type==='ad')return{type,slot:s.slot||'article-1'};if(type==='checklist')return{type,items:Array.isArray(s.items)?s.items:arr(s.items)};return{type:type==='intro'?'intro':type==='html'?'html':'paragraph',content:pick(s,'content','text','html')}}
function normalizePost(raw={}){let sections=raw.sections;if(typeof sections==='string'){try{sections=JSON.parse(sections)}catch{sections=[]}}if(!Array.isArray(sections)||!sections.length){const c=pick(raw,'content','body','article','focus');if(c)sections=[{type:'intro',content:c}]}sections=(sections||[]).map(normalizeSection).filter(Boolean);let fi=raw.featured_image;if(typeof fi==='string'){try{fi=JSON.parse(fi)}catch{fi={filename:fi}}}if(!fi&&pick(raw,'featured_image_filename','featured_filename'))fi={filename:pick(raw,'featured_image_filename','featured_filename'),alt_text:pick(raw,'featured_image_alt','featured_alt'),prompt:raw.featured_image_prompt||'',caption:raw.featured_image_caption||''};if(fi)fi={filename:pick(fi,'filename','file'),alt_text:pick(fi,'alt_text','alt'),prompt:fi.prompt||'',caption:fi.caption||'',purpose:fi.purpose||''};const title=pick(raw,'title','headline');return{post_id:pick(raw,'post_id','postId'),title,slug:pick(raw,'slug')||slug(title),excerpt:pick(raw,'excerpt','description','meta_description'),primary_keyword:raw.primary_keyword||'',secondary_keywords:arr(raw.secondary_keywords),categories:arr(pick(raw,'categories','category')),tags:arr(raw.tags),status:raw.status||'draft',date:raw.date||'',featured_image:fi||null,sections}}
function validate(p,assetNames=[]){const errors=[],warnings=[];if(!p.post_id)errors.push('Missing post_id');if(!p.title)errors.push('Missing title');if(!p.sections?.length)errors.push('Missing sections');if(p.post_id&&/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(p.post_id))errors.push('post_id cannot be a random UUID');const required=[...(p.featured_image?.filename?[p.featured_image.filename]:[]),...p.sections.filter(s=>s.type==='image').map(s=>s.filename).filter(Boolean)];for(const n of required)if(assetNames.length&&!assetNames.some(x=>String(x).toLowerCase()===String(n).toLowerCase()))errors.push(`Missing asset: ${n}`);if(p.sections.some(s=>s.type==='image'&&!s.filename))errors.push('Image section missing filename');if(!p.featured_image?.filename)warnings.push('No featured image');return{ok:errors.length===0,errors,warnings,requiredImages:required.filter(n=>n!==p.featured_image?.filename),featured:p.featured_image?.filename||null}}
function parseCSV(text){const rows=[];let row=[],cell='',q=false;for(let i=0;i<text.length;i++){const c=text[i];if(q){if(c==='"'&&text[i+1]==='"'){cell+='"';i++}else if(c==='"')q=false;else cell+=c}else if(c==='"')q=true;else if(c===','){row.push(cell);cell=''}else if(c==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell=''}else cell+=c}if(cell||row.length){row.push(cell.replace(/\r$/,''));rows.push(row)}const h=(rows.shift()||[]).map(x=>x.trim());return rows.filter(r=>r.some(Boolean)).map(r=>Object.fromEntries(h.map((k,i)=>[k,r[i]??''])))}
const mimeFor=n=>n.endsWith('.png')?'image/png':n.endsWith('.webp')?'image/webp':'image/jpeg';
function parseManifestObject(j){return Array.isArray(j)?j:(Array.isArray(j.posts)?j.posts:[j])}
async function importEntries(entries){
  const assetMap=new Map();
  const jsonEntries=[];
  const csvEntries=[];
  const looseEntries=[];

  for(const e of entries){
    const n=e.name.toLowerCase(),b=e.buffer,base=e.name.split('/').pop();
    if(/\.(png|jpe?g|webp)$/i.test(n)){
      assetMap.set(base,{name:base,mime:mimeFor(n),buffer:b});
      continue;
    }
    if(n.endsWith('.json')){jsonEntries.push(e);continue}
    if(n.endsWith('.csv')){csvEntries.push(e);continue}
    looseEntries.push(e);
  }

  let rawPosts=[];
  let manifestSource='';

  // A complete ZIP may intentionally contain BOTH aura-posts.json and aura-posts.csv.
  // They are alternate representations of the same posts, so never import both.
  // Prefer the canonical JSON manifest because it preserves nested sections/images safely.
  const preferredJson=jsonEntries.find(e=>/(^|\/)aura-posts\.json$/i.test(e.name))
    || jsonEntries.find(e=>/(^|\/)(posts|articles|manifest)\.json$/i.test(e.name));

  const usableJson=[];
  for(const e of jsonEntries){
    try{
      const j=JSON.parse(e.buffer.toString());
      const candidates=Array.isArray(j)?j:(Array.isArray(j?.posts)?j.posts:[]);
      // Ignore asset manifests, validation fixtures, metadata JSON, etc.
      if(candidates.length && candidates.some(x=>x && typeof x==='object' && (x.post_id||x.title||x.sections))) usableJson.push({e,j,candidates});
    }catch(err){
      if(e===preferredJson) throw new Error(`Invalid JSON in ${e.name}: ${err.message}`);
    }
  }

  let chosen=null;
  if(preferredJson) chosen=usableJson.find(x=>x.e===preferredJson)||null;
  if(!chosen) chosen=usableJson.find(x=>Array.isArray(x.j?.posts))||usableJson[0]||null;

  if(chosen){
    rawPosts=chosen.candidates;
    manifestSource=chosen.e.name;
  }else if(csvEntries.length){
    const preferredCsv=csvEntries.find(e=>/(^|\/)aura-posts\.csv$/i.test(e.name))||csvEntries[0];
    rawPosts=parseCSV(preferredCsv.buffer.toString()).map(row=>{
      // CSV packages from the Aura prompt serialize the full section array here.
      if(!row.sections && row.sections_json){
        try{row.sections=JSON.parse(row.sections_json)}catch(err){row._sections_parse_error=`Invalid sections_json: ${err.message}`}
      }
      return row;
    });
    manifestSource=preferredCsv.name;
  }else{
    // Loose document import remains supported when no structured manifest exists.
    for(const e of looseEntries){
      const n=e.name.toLowerCase(),b=e.buffer;
      if(n.endsWith('.md')||n.endsWith('.txt')||n.endsWith('.html')){const t=b.toString(),title=t.split(/\r?\n/).find(Boolean)?.replace(/^#+\s*/,'')||e.name;rawPosts.push({post_id:e.name.replace(/\..+$/,''),title,sections:[{type:n.endsWith('.html')?'html':'paragraph',content:t}],status:'draft'})}
      else if(n.endsWith('.docx')){const x=await mammoth.convertToHtml({buffer:b});rawPosts.push({post_id:e.name.replace(/\.docx$/i,''),title:e.name.replace(/\.docx$/i,''),sections:[{type:'html',content:x.value}]})}
      else if(n.endsWith('.pdf')){const x=await pdf(b);rawPosts.push({post_id:e.name.replace(/\.pdf$/i,''),title:x.text.split(/\r?\n/).find(Boolean)||e.name,sections:[{type:'paragraph',content:x.text}]})}
    }
    manifestSource=looseEntries.length?'loose documents':'';
  }

  const posts=rawPosts.map(raw=>{
    const p=normalizePost(raw);
    if(raw?._sections_parse_error) p._sections_parse_error=raw._sections_parse_error;
    return p;
  });
  const names=[...assetMap.keys()];
  const seen=new Set();
  for(const p of posts){
    p.validation=validate(p,names);
    if(p._sections_parse_error){p.validation.ok=false;p.validation.errors.push(p._sections_parse_error);delete p._sections_parse_error}
    if(p.post_id&&seen.has(p.post_id)){p.validation.ok=false;p.validation.errors.push(`Duplicate post_id inside selected manifest: ${p.post_id}`)}
    if(p.post_id)seen.add(p.post_id);
  }
  return{
    protocolVersion:'10.0',
    manifestSource,
    posts,
    assets:[...assetMap.values()].map(a=>({name:a.name,mime:a.mime,size:a.buffer.length,dataBase64:a.buffer.toString('base64')})),
    summary:{posts:posts.length,assets:names.length,ready:posts.filter(p=>p.validation.ok).length,invalid:posts.filter(p=>!p.validation.ok).length}
  }
}
async function termId(w,type,name){const a=await wpFetch(w,`${type}?search=${encodeURIComponent(name)}&per_page=100`),hit=a.find(x=>x.name.toLowerCase()===name.toLowerCase());if(hit)return hit.id;return(await wpFetch(w,type,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})})).id}
async function uploadMedia(w,file,alt=''){const r=await wpFetch(w,'media',{method:'POST',headers:{'Content-Type':file.mimetype||'application/octet-stream','Content-Disposition':`attachment; filename="${file.originalname.replace(/"/g,'')}"`},body:file.buffer});if(alt)await wpFetch(w,`media/${r.id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({alt_text:alt})});return r}
const esc=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');function renderPost(p,media){return p.sections.map(s=>s.type==='heading'?`<h${s.level}>${esc(s.content)}</h${s.level}>`:s.type==='image'?(media[s.filename]?`<figure class="wp-block-image"><img src="${media[s.filename].source_url}" alt="${esc(s.alt_text)}">${s.caption?`<figcaption>${esc(s.caption)}</figcaption>`:''}</figure>`:`<!-- AURA:MISSING:${s.filename} -->`):s.type==='ad'?`<!-- AURA:AD:${esc(s.slot)} --><div class="aura-ad-slot" data-slot="${esc(s.slot)}"></div>`:s.type==='checklist'?`<ul>${s.items.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:s.type==='html'?s.content:`<p>${esc(s.content)}</p>`).join('')}
app.get('/',(q,r)=>r.type('html').send('<h1>Aura Publisher Pro API</h1><p>Online — V10 Manifest Pipeline</p>'));app.get('/healthz',(q,r)=>r.json({ok:true,status:'online',service:'Aura Publisher Pro API',version:'4.0.0'}));app.get('/health',(q,r)=>r.json({ok:true,status:'online',service:'Aura Publisher Pro API',version:'4.0.0'}));
app.post('/api/wp/test',async(req,res)=>{try{const w=req.body.wordpress||{},d=await discoverWp(w),creds={...w,url:d.site,restRoot:d.root},me=await wpFetch(creds,'users/me?context=edit');res.json({ok:true,site:d.site,restRoot:d.root,user:{id:me.id,name:me.name,slug:me.slug,email:me.email||''},capabilities:me.capabilities||{}})}catch(e){const o=wpError(e);res.status(400).json(o)}});
app.post('/api/import',upload.array('files',150),async(req,res)=>{try{const entries=[];for(const f of req.files||[]){if(f.originalname.toLowerCase().endsWith('.zip')){const z=new AdmZip(f.buffer);for(const e of z.getEntries())if(!e.isDirectory&&!e.entryName.startsWith('__MACOSX/'))entries.push({name:e.entryName,buffer:e.getData()})}else entries.push({name:f.originalname,buffer:f.buffer})}if(!entries.length)return res.status(400).json({error:'Choose at least one file or ZIP package.'});res.json(await importEntries(entries))}catch(e){res.status(400).json({error:`Import failed: ${e.message}`})}});
app.post('/api/publish',upload.array('assets',150),async(req,res)=>{try{const w=JSON.parse(req.body.wordpress),p=normalizePost(JSON.parse(req.body.post)),files=Object.fromEntries((req.files||[]).map(f=>[f.originalname,f])),v=validate(p,Object.keys(files));if(!v.ok)return res.status(422).json({error:'Post is not publish-ready.',...v});const d=await discoverWp(w),creds={...w,url:d.site,restRoot:d.root},media={};for(const name of [...new Set([...v.requiredImages,v.featured].filter(Boolean))]){const f=files[name];if(!f)return res.status(422).json({error:`Required image missing from device asset store: ${name}`});const sec=p.sections.find(x=>x.filename===name),alt=sec?.alt_text||p.featured_image?.alt_text||'';media[name]=await uploadMedia(creds,f,alt)}const cats=[];for(const x of p.categories)cats.push(await termId(creds,'categories',x));const tags=[];for(const x of p.tags)tags.push(await termId(creds,'tags',x));const body={title:p.title,slug:p.slug,excerpt:p.excerpt,content:renderPost(p,media),status:p.status||'draft',categories:cats,tags,featured_media:v.featured&&media[v.featured]?.id||0};if(p.date)body.date=p.date;const out=await wpFetch(creds,'posts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});res.json({ok:true,id:out.id,link:out.link,status:out.status,uploadedImages:Object.keys(media).length})}catch(e){const o=wpError(e);res.status(400).json(o)}});
app.use((req,res)=>res.status(404).json({error:'Route not found',path:req.path}));app.use((e,q,r,n)=>r.status(400).json({error:e.message}));app.listen(PORT,'0.0.0.0',()=>console.log(`Aura V10 listening on ${PORT}`));
