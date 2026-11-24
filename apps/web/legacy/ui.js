// ================= UI =================
const $=id=>document.getElementById(id);
const css=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const STATUS_TXT={g:"Potentially permit-free",y:"Permit or conditions",r:"Not feasible"};
const VERDICT={g:"Potentially permit-free under the sample rules.",y:"Feasible, but a permit is needed or conditions apply.",r:"Not feasible at this position."};
const ORIENT_TXT={ns:"opens to the front or back",ew:"opens to the side"};
const houseOf=id=>HOUSES.find(h=>h.id===id)||HOUSES[0];
const cache={}; const ready=(id,s)=>!!cache[id+s];
const get=(id,s)=>{ const k=id+s; if(!cache[k]) cache[k]=analyse(houseOf(id),s); return cache[k]; };
const state={house:"A",size:"single",option:0,custom:null,showYellow:true,view:"2d",bay:0};
const reduceMotion=()=>matchMedia("(prefers-reduced-motion: reduce)").matches;
function visibleOptions(res){ return res.options.filter(o=>state.showYellow||o.status==="g"); }
function current(){ const H=houseOf(state.house), res=get(H.id,state.size), opts=visibleOptions(res);
  let r=null; if(state.custom) r=state.custom; else { if(state.option>=opts.length) state.option=0; r=opts[state.option]?opts[state.option].r:null; }
  const e=r?evaluate(H,r,true):null; if(!e||!e.acc||state.bay>=e.acc.bays.length) state.bay=Math.min(state.bay,e&&e.acc?e.acc.bays.length-1:0);
  return {H,res,opts,r,e,custom:!!state.custom}; }
const defaultDims=(o)=>footprint(SIZES[state.size],o);
const sameDims=r=>{ const f=defaultDims(r.o); return Math.abs(f.w-r.w)<1e-9&&Math.abs(f.d-r.d)<1e-9; };
function permitsOf(e){ const p=new Set(); e.trace.filter(t=>t.res==="cond").forEach(t=>{ if(t.cat==="Driveway exit") p.add(t.text.includes("wider")?"Justification for a wider exit":"Uitwegvergunning (driveway exit permit)"); else p.add("Omgevingsvergunning (building permit)"); }); return [...p]; }
const placeName=(H,r)=>`${ZONE_LABEL[zoneOf(H,r)]} · ${r.o==="ew"?"opens to the side":"opens front/back"}`;

// Typical Dutch residential street in front of the plot: pavement, green verge with trees, then the carriageway.
const STREET={pave:2,verge:2,carr:5,total:9,paveC:"#e6e9ec",vergeC:"#dfe9d7"};
const soY=so=>so.kind==="street tree"?-(STREET.pave+STREET.verge/2):so.kind==="lamp post"?-(STREET.pave-0.3):-0.4;
// ---------- 2D plan ----------
function carBody(fill,stroke){ return `<rect x="-0.9" y="-3.6" width="1.8" height="4.5" rx="0.45" fill="${fill}" stroke="${stroke}" stroke-width="0.08"/>`+
  `<rect x="-0.7" y="-2.55" width="1.4" height="0.55" rx="0.12" fill="${css('--house')}" opacity=".8"/><rect x="-0.65" y="0.05" width="1.3" height="0.4" rx="0.1" fill="${css('--house')}" opacity=".6"/>`; }
const carTf=(p,D)=>`translate(${p.x.toFixed(3)},${(D-p.y).toFixed(3)}) rotate(${(p.a*180/Math.PI).toFixed(2)})`;
function sweptD(poses,D){ let d=""; const n=poses.length;
  for(let i=0;i<n;i++){ const c=carCorners(poses[i].x,poses[i].y,poses[i].a);
    d+=`M${c[0].toFixed(2)},${(D-c[1]).toFixed(2)}L${c[2].toFixed(2)},${(D-c[3]).toFixed(2)}L${c[4].toFixed(2)},${(D-c[5]).toFixed(2)}L${c[6].toFixed(2)},${(D-c[7]).toFixed(2)}Z`; }
  return d; }
const centreLine=(poses,D)=>poses.map(p=>`${(p.x+BODYC*Math.sin(p.a)).toFixed(2)},${(D-(p.y+BODYC*Math.cos(p.a))).toFixed(2)}`).join(" ");
function planSVG(cur,cfg={}){
  const {H,res,opts,r,e}=cur, W=H.plot.w, D=H.plot.d, mL=cfg.mini?2:7, mR=cfg.mini?2:7, mT=cfg.mini?1:3, roadD=STREET.total;
  const vx=-mL, vy=-mT, vw=W+mL+mR, vh=D+mT+roadD+(cfg.mini?0.5:2), Y=(y,d=0)=>D-(y+d);
  let s=`<defs><pattern id="hatch${cfg.mini?"m":""}" width="0.6" height="0.6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="0.6" stroke="${css('--line')}" stroke-width="0.12"/></pattern></defs>`;
  const P=STREET.pave, V=STREET.verge, C=D+P+V;
  s+=`<rect x="${vx}" y="${D}" width="${vw}" height="${P}" fill="${STREET.paveC}"/><rect x="${vx}" y="${D+P}" width="${vw}" height="${V}" fill="${STREET.vergeC}"/>`;
  if(H.exit) s+=`<rect x="${H.exit.x0}" y="${D+P-0.01}" width="${H.exit.x1-H.exit.x0}" height="${V+0.02}" fill="${STREET.paveC}"/>`;
  s+=`<rect x="${vx}" y="${C}" width="${vw}" height="${STREET.carr}" fill="${css('--road')}"/><line x1="${vx}" y1="${C}" x2="${vx+vw}" y2="${C}" stroke="${css('--house')}" stroke-width="0.08"/>`;
  s+=`<line x1="${vx}" y1="${C+STREET.carr/2}" x2="${vx+vw}" y2="${C+STREET.carr/2}" stroke="${css('--panel')}" stroke-width="0.15" stroke-dasharray="1.5 1.2"/>`;
  if(!cfg.mini) s+=`<text x="${vx+0.8}" y="${C+STREET.carr/2-0.5}" font-size="0.85" fill="${css('--ink')}" opacity=".7">${H.address.replace(/\s\d+$/,"")}</text>`;
  for(const n of H.neighbours) s+=`<rect x="${n.x}" y="${Y(n.y,n.d)}" width="${n.w}" height="${n.d}" fill="${css('--neigh')}" stroke="${css('--line')}" stroke-width="0.08"/>`;
  s+=`<rect x="${vx}" y="${vy}" width="${-vx}" height="${D-vy}" fill="url(#hatch${cfg.mini?"m":""})" opacity=".7"/><rect x="${W}" y="${vy}" width="${mR}" height="${D-vy}" fill="url(#hatch${cfg.mini?"m":""})" opacity=".7"/>`;
  if(!cfg.mini) s+=`<text x="${vx+0.6}" y="${vy+1.6}" font-size="0.8" fill="${css('--muted')}">neighbour</text><text x="${W+0.6}" y="${vy+1.6}" font-size="0.8" fill="${css('--muted')}">neighbour</text>`;
  s+=`<rect x="0" y="0" width="${W}" height="${D}" fill="${css('--plot')}" stroke="${css('--accent')}" stroke-width="0.14"/>`;
  if(!cfg.mini&&(!r||sameDims(r))){ const {cw,cd,data}=res.cells, st=RULE.step;
    for(let j=0;j<cd;j++) for(let i=0;i<cw;i++){ const v=data[j*cw+i]; if(!v||(v===1&&!state.showYellow)) continue;
      s+=`<rect x="${i*st}" y="${D-(j+1)*st}" width="${st+0.01}" height="${st+0.01}" fill="${css(v===2?'--ok-soft':'--warn-soft')}"/>`; } }
  const fl=Y(facade(H)+RULE.frontBehind);
  s+=`<line x1="-1" y1="${fl}" x2="${W+1}" y2="${fl}" stroke="${css('--accent')}" stroke-width="0.1" stroke-dasharray="0.8 0.5"/>`;
  if(!cfg.mini) s+=`<text x="${W+0.4}" y="${fl+0.3}" font-size="0.75" fill="${css('--accent')}">back-yard area</text>`;
  for(const t of H.trees){ s+=`<circle cx="${t.x}" cy="${Y(t.y)}" r="${t.r+RULE.rootBuffer}" fill="none" stroke="${css('--bad')}" stroke-width="0.1" stroke-dasharray="0.5 0.35"/>`;
    s+=`<circle cx="${t.x}" cy="${Y(t.y)}" r="${t.r}" fill="${css('--tree')}" opacity=".85"/>`; if(!cfg.mini) s+=`<text x="${t.x}" y="${Y(t.y)+0.3}" font-size="0.7" text-anchor="middle" fill="${css('--panel')}">tree</text>`; }
  const h=H.house;
  s+=`<rect x="${h.x}" y="${Y(h.y,h.d)}" width="${h.w}" height="${h.d}" fill="${css('--house')}" stroke="${css('--ink')}" stroke-width="0.1"/>`;
  s+=`<line x1="${h.x}" y1="${Y(h.y+h.d/2)}" x2="${h.x+h.w}" y2="${Y(h.y+h.d/2)}" stroke="${css('--ink')}" stroke-width="0.06" opacity=".5"/>`;
  s+=`<text x="${h.x+h.w/2}" y="${Y(h.y+h.d/2)-0.5}" font-size="${cfg.mini?1.2:0.9}" text-anchor="middle" fill="${css('--panel')}">house</text>`;
  for(const o of H.sheds){ s+=`<rect x="${o.x}" y="${Y(o.y,o.d)}" width="${o.w}" height="${o.d}" fill="${css('--neigh')}" stroke="${css('--ink')}" stroke-width="0.06"/>`; if(!cfg.mini) s+=`<text x="${o.x+o.w/2}" y="${Y(o.y+o.d/2)+0.3}" font-size="0.7" text-anchor="middle" fill="${css('--ink')}">shed</text>`; }
  if(H.exit) s+=`<rect x="${H.exit.x0}" y="${D-0.08}" width="${H.exit.x1-H.exit.x0}" height="0.5" fill="${css('--accent')}" opacity=".55"/>`;
  for(const so of H.street||[]){ const sy=D-soY(so), big=so.kind==="street tree";
    s+=big?`<circle cx="${so.x}" cy="${sy}" r="1.1" fill="${css('--tree')}" opacity=".85"/>`:so.kind==="lamp post"?`<circle cx="${so.x}" cy="${sy}" r="0.3" fill="${css('--ink')}"/>`:`<rect x="${so.x-0.45}" y="${sy-0.25}" width="0.9" height="0.5" fill="${css('--ink')}"/>`;
    if(!cfg.mini) s+=`<text x="${so.x}" y="${sy+(big?1.8:1.0)}" font-size="0.65" text-anchor="middle" fill="${css('--ink')}">${so.kind}</text>`; }
  // alternatives (numbered)
  if(!cfg.mini) opts.forEach((o,i)=>{ if(!cur.custom&&i===state.option) return; const q=o.r, col=css(o.status==="g"?'--ok':'--warn');
    s+=`<g class="opt" data-i="${i}" style="cursor:pointer" tabindex="0" role="button" aria-label="Alternative ${i+1}: ${placeName(H,q)}, ${STATUS_TXT[o.status]}">`+
       `<rect x="${q.x}" y="${Y(q.y,q.d)}" width="${q.w}" height="${q.d}" fill="${css('--panel')}" fill-opacity=".01" stroke="${col}" stroke-width="0.12" stroke-dasharray="0.5 0.3"/>`+
       `<circle cx="${q.x+q.w/2}" cy="${Y(q.y+q.d/2)}" r="0.8" fill="${col}"/><text x="${q.x+q.w/2}" y="${Y(q.y+q.d/2)+0.32}" font-size="0.9" text-anchor="middle" fill="${css('--panel')}" font-weight="600">${i+1}</text></g>`; });
  if(r&&e){ const col=css(e.status==="g"?'--ok':e.status==="y"?'--warn':'--bad');
    // swept path(s)
    if(e.acc&&e.acc.exit&&e.acc.mode==="new"){ const ex=e.acc.exit; s+=`<rect x="${ex.x0}" y="${D+STREET.pave}" width="${ex.x1-ex.x0}" height="${STREET.verge}" fill="${STREET.paveC}" stroke="${css('--accent')}" stroke-width="0.08" stroke-dasharray="0.4 0.3" pointer-events="none"/>`; }
    if(e.acc){ e.acc.bays.forEach((B,bi)=>{ if(!cfg.mini&&bi!==state.bay) return;
        if(B.ok){ s+=`<path d="${sweptD(B.poses,D)}" fill="${css('--accent')}" opacity="${cfg.mini?0.16:0.2}" pointer-events="none"/>`;
          s+=`<polyline points="${centreLine(B.poses,D)}" fill="none" stroke="${css('--accent')}" stroke-width="0.1" stroke-dasharray="0.6 0.4" pointer-events="none"/>`; }
        else if(B.attempt){ const ps=B.attempt.poses.slice(0,B.attempt.hit+1);
          s+=`<path d="${sweptD(ps,D)}" fill="${css('--bad')}" opacity=".16" pointer-events="none"/><polyline points="${centreLine(ps,D)}" fill="none" stroke="${css('--bad')}" stroke-width="0.1" stroke-dasharray="0.6 0.4" pointer-events="none"/>`; } });
      if(e.acc.exit&&!cfg.mini){ const ex=e.acc.exit; s+=`<line x1="${ex.x0}" y1="${D+0.35}" x2="${ex.x1}" y2="${D+0.35}" stroke="${css('--accent')}" stroke-width="0.14"/><line x1="${ex.x0}" y1="${D}" x2="${ex.x0}" y2="${D+0.7}" stroke="${css('--accent')}" stroke-width="0.08"/><line x1="${ex.x1}" y1="${D}" x2="${ex.x1}" y2="${D+0.7}" stroke="${css('--accent')}" stroke-width="0.08"/>`;
        const right=ex.x1+4<W+mR&&!(H.street||[]).some(so=>so.x>ex.x1&&so.x<ex.x1+6); s+=`<text x="${right?ex.x1+0.4:ex.x0-0.4}" y="${D+1.25}" font-size="0.7" text-anchor="${right?"start":"end"}" fill="${css('--accent')}">${e.acc.mode==="existing"?"existing exit":"new exit"} · ${fmt(ex.w)} m</text>`; } }
    // the footprint itself (drag handle)
    s+=`<g class="selfp" aria-label="Selected footprint, drag to move"><rect x="${r.x}" y="${Y(r.y,r.d)}" width="${r.w}" height="${r.d}" fill="${col}" fill-opacity=".22" stroke="${col}" stroke-width="0.2"/>`;
    for(const p of postRects(r)) s+=`<rect x="${p.x}" y="${Y(p.y,p.d)}" width="${p.w}" height="${p.d}" fill="${css('--ink')}"/>`;
    s+=`</g>`;
    // cars
    if(e.acc) e.acc.bays.forEach((B,bi)=>{
      if(cfg.mini||bi!==state.bay){ s+=`<g pointer-events="none" transform="${carTf(finalPose(B),D)}">${carBody(css('--panel'),css('--ink'))}</g>`; return; }
      if(B.ok) s+=`<g id="selcar" pointer-events="none" transform="${carTf(finalPose(B),D)}">${carBody(css('--accent-soft'),css('--accent'))}</g>`;
      else if(B.attempt) s+=`<g id="selcar" pointer-events="none" transform="${carTf(B.attempt.poses[B.attempt.hit],D)}">${carBody(css('--bad-soft'),css('--bad'))}</g>`; });
  }
  if(!cfg.mini){
    s+=`<line x1="0" y1="-1.4" x2="${W}" y2="-1.4" stroke="${css('--muted')}" stroke-width="0.06"/><line x1="0" y1="-1.8" x2="0" y2="-1" stroke="${css('--muted')}" stroke-width="0.06"/><line x1="${W}" y1="-1.8" x2="${W}" y2="-1" stroke="${css('--muted')}" stroke-width="0.06"/>`;
    s+=`<text x="${W/2}" y="-1.7" font-size="0.8" text-anchor="middle" fill="${css('--muted')}">${fmt(W)} m</text>`;
    s+=`<g transform="translate(${vx+0.8},${D+roadD-0.8})"><rect x="0" y="-0.25" width="5" height="0.25" fill="${css('--ink')}"/><rect x="5" y="-0.25" width="5" height="0.25" fill="${css('--panel')}" stroke="${css('--ink')}" stroke-width="0.05"/><text x="0" y="-0.55" font-size="0.65" fill="${css('--ink')}">0</text><text x="9.4" y="-0.55" font-size="0.65" fill="${css('--ink')}">10 m</text></g>`; }
  return {s,vb:`${vx} ${vy} ${vw} ${vh}`};
}
function renderPlan(cur){
  const svg=$("plan"), {s,vb}=planSVG(cur); svg.setAttribute("viewBox",vb); svg.innerHTML=s; svg._D=cur.H.plot.d;
  $("lg-exit").hidden=!cur.H.exit;
  svg.querySelectorAll(".opt").forEach(g=>{ const go=()=>{ state.option=+g.dataset.i; state.custom=null; state.bay=0; renderCheck(); }; g.onclick=go; g.onkeydown=ev=>{ if(ev.key==="Enter"||ev.key===" "){ ev.preventDefault(); go(); } }; });
}

// ---------- Drag a footprint ----------
let drag=null, dragRaf=0;
function svgPoint(svg,ev,inv){ const pt=svg.createSVGPoint(); pt.x=ev.clientX; pt.y=ev.clientY; const m=inv||(svg.getScreenCTM()&&svg.getScreenCTM().inverse()); return m?pt.matrixTransform(m):pt; }
$("plan").addEventListener("pointerdown",ev=>{ if(!ev.target.closest(".selfp")) return; const cur=current(); if(!cur.r) return;
  stopAnim(); const svg=$("plan"), m=svg.getScreenCTM(), inv=m?m.inverse():null, p=svgPoint(svg,ev,inv); drag={x0:p.x,y0:p.y,r0:{...cur.r},inv}; svg.setPointerCapture(ev.pointerId); ev.preventDefault(); });
$("plan").addEventListener("pointermove",ev=>{ if(!drag) return; const p=svgPoint($("plan"),ev,drag.inv), H=houseOf(state.house);
  const nx=Math.min(H.plot.w-drag.r0.w,Math.max(0,snapG(drag.r0.x+(p.x-drag.x0)))), ny=Math.min(H.plot.d-drag.r0.d,Math.max(0,snapG(drag.r0.y-(p.y-drag.y0))));
  const cr=state.custom||{}; if(cr.x===nx&&cr.y===ny) return;
  state.custom={...drag.r0,x:nx,y:ny}; cancelAnimationFrame(dragRaf); dragRaf=requestAnimationFrame(()=>renderCheck(false,true)); });
const endDrag=()=>{ if(drag){ drag=null; renderCheck(); } };
$("plan").addEventListener("pointerup",endDrag); $("plan").addEventListener("pointercancel",endDrag);

// ---------- Short flags shown on the plan ----------
function shortOf(t){ const x=t.text;
  switch(t.cat){
    case "Heritage": return "Listed monument: building permit";
    case "Trees": return "In the protected tree's root zone";
    case "Placement": return x.includes("outside")?"Partly outside the plot":"Overlaps the house or shed";
    case "Position": return x.startsWith("Within")?"Within 1 m of the road: building permit":"Front yard: building permit";
    case "Height": return "Too high to be permit-free";
    case "Area": return "Too much annex area: building permit";
    case "Parking": return x.includes("doors")?"No room to open the doors":"The car doesn't fit inside";
    case "Vehicle access": return x.includes("parked car")?"Blocked by the parked car":x.includes("post")?"Hits a carport post":"The car can't get in (turning circle)";
    case "Driveway exit": return x.includes("pavement")?`Exit blocked by the ${(x.match(/the ([a-z ]+?) (?:on the pavement|:)/)||[,"street object"])[1]}`:x.includes("wider")?"Exit wider than 3 m: justification":x.includes("already has")?"Second exit may be refused":"New driveway exit: permit";
  } return x; }
function renderFlag(cur){ const f=$("flag"); if(!cur.r){ f.innerHTML=`<span class="pill r">Not feasible</span><div>No position of this size fits</div>`; return; }
  const e=cur.e, fails=e.trace.filter(t=>t.res==="fail"), conds=e.trace.filter(t=>t.res==="cond"), items=(fails.length?fails:conds).map(shortOf);
  f.innerHTML=`<span class="pill ${e.status}">${STATUS_TXT[e.status]}</span>`+(items.length?`<ul>${[...new Set(items)].slice(0,3).map(i=>`<li>${i}</li>`).join("")}</ul>`:`<div>No permit needed under the sample rules</div>`); }

// ---------- Result + checks ----------
function renderResult(cur){
  const {H,res,r,e}=cur, el=$("result");
  const blocked=Object.entries(res.failReasons).map(([z,m])=>{ const has=res.placements.some(p=>p.zone===z); const top=Object.entries(m).sort((a,b)=>b[1]-a[1])[0]; return (!has&&top)?`<li><b>${ZONE_LABEL[z]}:</b> ${top[0].toLowerCase()}</li>`:""; }).join("");
  const exBtn=res.blockedEx?`<p class="alt"><button class="btn small" id="try-blocked">Show a blocked example</button></p>`:"";
  if(!r){ el.innerHTML=`<div class="detail-top"><span class="pill r">Not feasible</span></div><p class="verdict">No ${state.showYellow?"":"permit-free "}carport position of this size fits on this property${state.showYellow?"":". Turn on “Show positions that need a permit” to see the others"}.</p>${blocked?`<div class="blocked"><b>Why</b><ul>${blocked}</ul></div>`:""}${exBtn}`;
    $("checks").hidden=true; bindTry(); return; }
  $("checks").hidden=false;
  const permits=permitsOf(e), fail=e.trace.find(t=>t.res==="fail"), acc=e.acc;
  const access=acc&&acc.mode!=="none"?acc.bays.map(b=>`${acc.bays.length>1?`Bay ${b.b+1}: `:""}${b.route.txt}`).join("<br>"):"—";
  const allReady=acc&&acc.bays.every(b=>!b.ok||exitReady(H,r,b.b));
  const out=acc&&acc.mode!=="none"?(allReady?acc.bays.map(b=>{ const x=exitFor(H,r,b.b); return `${acc.bays.length>1?`Bay ${b.b+1}: `:""}${x?x.txt:"reverses along the way in"}`; }).join("<br>"):`<span class="muted">working it out…</span>`):"—";
  if(acc&&acc.mode!=="none"&&!allReady&&!drag){ const key=JSON.stringify(r); setTimeout(()=>{ acc.bays.forEach(b=>{ if(b.ok) exitFor(H,r,b.b); }); const c=current(); if(c.r&&JSON.stringify(c.r)===key) renderResult(c); },30); }
  const exit=acc&&acc.exit?`${acc.mode==="existing"?"Existing exit":"New exit"}, ${fmt(acc.exit.w)} m wide`:"—";
  el.innerHTML=`<div class="detail-top"><h3>${cur.custom?"Custom footprint":`Position ${state.option+1}`}</h3><span class="pill ${e.status}">${STATUS_TXT[e.status]}</span></div>
    <div class="muted" style="font-size:13px">${placeName(H,r)}</div>
    <p class="verdict">${VERDICT[e.status]}${fail?` ${fail.text}`:""}</p>
    <dl class="kv"><dt>Footprint</dt><dd>${fmt(r.o==="ns"?r.w:r.d)} × ${fmt(r.o==="ns"?r.d:r.w)} m · ${fmt(r.w*r.d)} m² · ${fmt(RULE.carportH)} m high</dd>
    <dt>Way in</dt><dd>${access}</dd><dt>Way out</dt><dd>${out}</dd><dt>Driveway exit</dt><dd>${exit}</dd>
    <dt>Permits likely</dt><dd>${e.status==="r"?"—":permits.length?permits.join("<br>"):"None under the sample rules"}</dd></dl>
    ${blocked&&!cur.custom?`<div class="blocked"><b>Not possible elsewhere</b><ul>${blocked}</ul></div>`:""}${exBtn}`;
  const grp=(title,items,ic)=>items.length?`<div class="group"><h4>${title}</h4><ul class="trace">${items.map(t=>`<li class="${t.res}"><span class="ic">${ic(t)}</span><div><span class="cat">${t.cat}</span>${t.text}${t.src?`<span class="src">${t.src}</span>`:""}</div></li>`).join("")}</ul></div>`:"";
  const checked=e.trace.filter(t=>!["assume","missing"].includes(t.res)), assumed=e.trace.filter(t=>t.res==="assume"), missing=e.trace.filter(t=>t.res==="missing");
  $("checks-sum").innerHTML=`Checks and sources <span class="muted">· ${checked.length} checked · ${assumed.length} assumed · ${missing.length} not checked</span>`;
  $("checklist").innerHTML=grp("Checked by the prototype",checked,t=>t.res==="pass"?"✓":t.res==="cond"?"!":t.res==="note"?"i":"✕")+grp("Assumed (not verified)",assumed,()=>"~")+grp("Not checked: information missing",missing,()=>"?");
  bindTry();
}
function bindTry(){ const b=$("try-blocked"); if(b) b.onclick=()=>{ const res=get(state.house,state.size); state.custom={...res.blockedEx}; state.bay=0;
  const e=evaluate(houseOf(state.house),state.custom,true); const k=e.acc?e.acc.bays.findIndex(q=>!q.ok):-1; if(k>=0) state.bay=k; renderCheck(); }; }

// ---------- Pipeline (replayable) ----------
function stepData(H,res){ const bs=backyardStats(H,{x:0,y:0,w:0,d:0});
  return [
    ["Property data","Fictional plot, house and trees. Live version: BAG and Kadaster (not connected).",true],
    ["Property model",`Front building line at ${fmt(facade(H))} m · back-yard building area ${Math.round(bs.bg)} m² · max ${Math.round(bs.max)} m² of annexes`],
    ["Rule set","Sample rules modelled on Gemeente Woensdrecht: omgevingsplan (annexes, monuments), driveway exit policy, Bomenlijst",true],
    ["Zoning & heritage",`Residential zoning (sample data) · ${H.monument?"listed monument (sample data): permit needed":"not a monument (sample data)"}`],
    ["Trees",H.trees.length?`${H.trees.length} tree on the sample Bomenlijst · protection zone excluded`:"No listed trees on the plot (sample data)"],
    ["Candidate positions",`${res.tested.toLocaleString("en-GB")} positions tested on a ${fmt(RULE.step)} m grid, in both orientations (opening front/back and to the side)`],
    ["Vehicle swept path",`Route search for a ${fmt(VEH.w)} × ${fmt(VEH.l)} m car: ${fmt(VEH.outerR)} m outer turning radius, ${fmt(VEH.clr)} m clearance, straight into the bay, other bay occupied`],
    ["Size & height","Height within or beyond 4 m of the house · total annex area in the back yard"],
    ["Result",`${res.g} potentially permit-free · ${res.y} with permit or conditions · ${res.r} not feasible`],
    ["Explanation",`${visibleOptions(res).length} suggested positions, each with its checks and sources`]]; }
let runTimer=null;
function renderSteps(animate){ const H=houseOf(state.house), res=get(H.id,state.size), ol=$("steps");
  ol.innerHTML=stepData(H,res).map(([t,d,sample],i)=>`<li><span class="n">${i+1}</span><div><div class="t">${t}${sample?'<span class="badge">sample</span>':""}</div><div class="d">${d}</div></div></li>`).join("");
  const lis=[...ol.children]; clearInterval(runTimer);
  if(!animate||reduceMotion()){ lis.forEach(l=>l.classList.add("done")); return; }
  let i=0; lis.forEach(l=>l.querySelector(".d").style.visibility="hidden");
  runTimer=setInterval(()=>{ if(i>0){ lis[i-1].classList.remove("active"); lis[i-1].classList.add("done"); }
    if(i>=lis.length){ clearInterval(runTimer); return; } lis[i].classList.add("active"); lis[i].querySelector(".d").style.visibility="visible"; i++; },180); }
$("run").onclick=()=>renderSteps(true);

// ---------- 3D ----------
let R3=null;
function init3D(){ if(R3||typeof THREE==="undefined") return; const el=$("three");
  const renderer=new THREE.WebGLRenderer({antialias:true}); renderer.setPixelRatio(Math.min(2,window.devicePixelRatio||1)); el.appendChild(renderer.domElement);
  const camera=new THREE.PerspectiveCamera(40,1,0.1,500), controls=new THREE.OrbitControls(camera,renderer.domElement); controls.maxPolarAngle=Math.PI*0.48;
  renderer.domElement.style.touchAction="none"; el.style.touchAction="none"; controls.enableDamping=false; controls.screenSpacePanning=true;
  R3={renderer,camera,controls,scene:null,el,movCar:null}; controls.addEventListener("change",()=>R3.scene&&R3.renderer.render(R3.scene,R3.camera));
  new ResizeObserver(()=>resize3D()).observe(el); }
function resize3D(){ if(!R3) return; const w=R3.el.clientWidth,h=R3.el.clientHeight; if(!w) return; R3.renderer.setSize(w,h,false); R3.renderer.domElement.style.width="100%"; R3.renderer.domElement.style.height="100%"; R3.camera.aspect=w/h; R3.camera.updateProjectionMatrix(); if(R3.scene) R3.renderer.render(R3.scene,R3.camera); }
// Low-poly car centred on its body; nose points to -Z before rotation.
function makeCar(paint){ const g=new THREE.Group();
  const mB=new THREE.MeshLambertMaterial({color:paint}), mG=new THREE.MeshLambertMaterial({color:0x2a3440}), mT=new THREE.MeshLambertMaterial({color:0x1d1f22}), mL=new THREE.MeshLambertMaterial({color:0xf2efe6});
  const add=(geo,mat,x,y,z)=>{ const m=new THREE.Mesh(geo,mat); m.position.set(x,y,z); g.add(m); };
  add(new THREE.BoxGeometry(1.8,0.62,4.5),mB,0,0.62,0); add(new THREE.BoxGeometry(1.62,0.5,2.3),mB,0,1.18,0.25); add(new THREE.BoxGeometry(1.64,0.36,2.0),mG,0,1.2,0.25);
  add(new THREE.BoxGeometry(0.4,0.12,0.04),mL,-0.55,0.72,-2.26); add(new THREE.BoxGeometry(0.4,0.12,0.04),mL,0.55,0.72,-2.26);
  const wh=new THREE.CylinderGeometry(0.33,0.33,0.24,18); wh.rotateZ(Math.PI/2); for(const [x,z] of [[-0.86,-1.35],[0.86,-1.35],[-0.86,1.35],[0.86,1.35]]) add(wh,mT,x,0.33,z);
  return g; }
function poseCar(g,p,W,D){ const cx=p.x+BODYC*Math.sin(p.a), cy=p.y+BODYC*Math.cos(p.a); g.position.set(cx-W/2,0,D/2-cy); g.rotation.y=-p.a; }
function build3D(resetCam){ if(!R3) return; const cur=current(), {H,res,r,e}=cur, W=H.plot.w, D=H.plot.d, X=x=>x-W/2, Z=y=>D/2-y;
  const sc=new THREE.Scene(); sc.background=new THREE.Color(css('--bg'));
  sc.add(new THREE.HemisphereLight(0xffffff,0x888888,0.75)); const sun=new THREE.DirectionalLight(0xffffff,0.65); sun.position.set(-20,40,-25); sc.add(sun);
  const mat=c=>new THREE.MeshLambertMaterial({color:new THREE.Color(css(c))});
  const box=(w,h,d,c,x,y,z)=>{ const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),typeof c==="string"?mat(c):c); m.position.set(x,y,z); sc.add(m); return m; };
  const g=new THREE.Mesh(new THREE.PlaneGeometry(W+60,D+60),mat('--ground')); g.rotation.x=-Math.PI/2; g.position.y=-0.02; sc.add(g);
  { const RS=16, RL=W+60, T=STREET.total, Cw=STREET.carr, rc=document.createElement("canvas"); rc.width=Math.round(RL*RS); rc.height=T*RS; const rx=rc.getContext("2d");
    rx.fillStyle=css('--road'); rx.fillRect(0,0,rc.width,Cw*RS); rx.fillStyle=STREET.vergeC; rx.fillRect(0,Cw*RS,rc.width,STREET.verge*RS); rx.fillStyle=STREET.paveC; rx.fillRect(0,(Cw+STREET.verge)*RS,rc.width,STREET.pave*RS);
    if(H.exit) rx.fillRect((H.exit.x0+30)*RS,Cw*RS,(H.exit.x1-H.exit.x0)*RS,STREET.verge*RS);
    rx.strokeStyle="#ffffff"; rx.lineWidth=3; rx.setLineDash([24,18]); rx.beginPath(); rx.moveTo(0,Cw/2*RS); rx.lineTo(rc.width,Cw/2*RS); rx.stroke(); rx.setLineDash([]);
    rx.save(); rx.translate((30+W/2)*RS,(Cw/2+0.6)*RS); rx.scale(1,-1); rx.fillStyle="#4a5561"; rx.font=`600 ${Math.round(1.1*RS)}px Inter, sans-serif`; rx.textAlign="center"; rx.fillText(H.address.replace(/\s\d+$/,""),0,0); rx.restore();
    const rt=new THREE.CanvasTexture(rc); rt.flipY=false; const road=new THREE.Mesh(new THREE.PlaneGeometry(RL,T),new THREE.MeshLambertMaterial({map:rt})); road.rotation.x=-Math.PI/2; road.position.set(0,0.005,Z(-T/2)); sc.add(road); }
  const S=24, cv=document.createElement("canvas"); cv.width=Math.round(W*S); cv.height=Math.round(D*S); const cx=cv.getContext("2d");
  cx.fillStyle=css('--plot'); cx.fillRect(0,0,cv.width,cv.height);
  if(!r||sameDims(r)){ const {cw,cd,data}=res.cells, st=RULE.step; cx.globalAlpha=0.35;
    for(let j=0;j<cd;j++) for(let i=0;i<cw;i++){ const v=data[j*cw+i]; if(!v||(v===1&&!state.showYellow)) continue; cx.fillStyle=css(v===2?'--ok':'--warn'); cx.fillRect(i*st*S,j*st*S,st*S+1,st*S+1); } cx.globalAlpha=1; }
  cx.strokeStyle=css('--accent'); cx.lineWidth=3; cx.setLineDash([12,8]); const fy=(facade(H)+RULE.frontBehind)*S; cx.beginPath(); cx.moveTo(0,fy); cx.lineTo(cv.width,fy); cx.stroke(); cx.setLineDash([]); cx.strokeRect(1,1,cv.width-2,cv.height-2);
  const label=(t,x,y,c)=>{ cx.save(); cx.translate(x*S,y*S); cx.scale(1,-1); cx.fillStyle=c; cx.font=`600 ${Math.round(0.75*S)}px Inter, sans-serif`; cx.fillText(t,0,0); cx.restore(); };
  label("Back-yard area starts here",0.4,facade(H)+RULE.frontBehind+0.35,css('--accent')); label("Front yard",0.4,0.6,css('--warn'));
  const B=e&&e.acc?e.acc.bays[state.bay]:null, sw=B?(B.ok?B.poses:B.attempt?B.attempt.poses.slice(0,B.attempt.hit+1):null):null;
  if(sw){ cx.fillStyle=css(B.ok?'--accent':'--bad'); cx.globalAlpha=0.22; cx.beginPath();
    sw.forEach((p,i)=>{ const c=carCorners(p.x,p.y,p.a); cx.moveTo(c[0]*S,Math.max(0,c[1])*S); for(let k=2;k<8;k+=2) cx.lineTo(c[k]*S,Math.max(0,c[k+1])*S); cx.closePath(); });
    cx.fill(); cx.globalAlpha=1; }
  const tex=new THREE.CanvasTexture(cv); tex.flipY=false; const plot=new THREE.Mesh(new THREE.PlaneGeometry(W,D),new THREE.MeshLambertMaterial({map:tex})); plot.rotation.x=-Math.PI/2; plot.position.set(0,0.01,0); sc.add(plot);
  const addHouse=(h,wallC,roofC,hh,ridge)=>{ box(h.w,hh,h.d,wallC,X(h.x+h.w/2),hh/2,Z(h.y+h.d/2));
    const sh=new THREE.Shape(); sh.moveTo(-h.d/2-0.3,0); sh.lineTo(h.d/2+0.3,0); sh.lineTo(0,ridge-hh); sh.lineTo(-h.d/2-0.3,0);
    const geo=new THREE.ExtrudeGeometry(sh,{depth:h.w+0.4,bevelEnabled:false}); geo.rotateY(Math.PI/2);
    const roof=new THREE.Mesh(geo,mat(roofC)); roof.position.set(X(h.x)-0.2,hh,Z(h.y+h.d/2)); sc.add(roof); };
  const hexM=c=>new THREE.MeshLambertMaterial({color:c});
  { const h=H.house, hh=h.h; box(h.w,hh,h.d,hexM(0xd9cfc3),X(h.x+h.w/2),hh/2,Z(h.y+h.d/2));
    const sh=new THREE.Shape(); sh.moveTo(-h.d/2-0.3,0); sh.lineTo(h.d/2+0.3,0); sh.lineTo(0,h.ridge-hh); sh.lineTo(-h.d/2-0.3,0);
    const geo=new THREE.ExtrudeGeometry(sh,{depth:h.w+0.4,bevelEnabled:false}); geo.rotateY(Math.PI/2); const roof=new THREE.Mesh(geo,hexM(0x9a5a43)); roof.position.set(X(h.x)-0.2,hh,Z(h.y+h.d/2)); sc.add(roof);
    const zf=Z(h.y)+0.06, zb=Z(h.y+h.d)-0.06, win=hexM(0x9fb6c8);
    box(1.0,2.1,0.12,hexM(0x3b2f2a),X(h.x+h.w/2),1.05,zf);
    const n=Math.max(2,Math.floor(h.w/2.6)); for(let i=0;i<n;i++){ const wx=X(h.x+(i+0.5)*h.w/n); if(Math.abs(wx-X(h.x+h.w/2))>0.9) box(1.2,1.2,0.1,win,wx,1.5,zf); box(1.2,1.1,0.1,win,wx,4.1,zf); box(1.2,1.2,0.1,win,wx,1.5,zb); } }
  for(const n of H.neighbours){ box(n.w,5.5,n.d,hexM(0xe7e3dd),X(n.x+n.w/2),2.75,Z(n.y+n.d/2));
    const sh=new THREE.Shape(); sh.moveTo(-n.d/2-0.3,0); sh.lineTo(n.d/2+0.3,0); sh.lineTo(0,3); sh.lineTo(-n.d/2-0.3,0); const geo=new THREE.ExtrudeGeometry(sh,{depth:n.w+0.4,bevelEnabled:false}); geo.rotateY(Math.PI/2);
    const rf=new THREE.Mesh(geo,hexM(0xc4b3a8)); rf.position.set(X(n.x)-0.2,5.5,Z(n.y+n.d/2)); sc.add(rf); }
  for(const so of H.street||[]){ const sx=X(so.x), sz=Z(soY(so));
    if(so.kind==="lamp post"){ box(0.14,4.5,0.14,hexM(0x46505a),sx,2.25,sz); box(0.5,0.18,0.3,hexM(0x46505a),sx,4.5,sz); }
    else if(so.kind==="street tree"){ box(0.3,2.6,0.3,hexM(0x6b5a4a),sx,1.3,sz); const cr=new THREE.Mesh(new THREE.SphereGeometry(1.4,14,10),mat('--tree')); cr.position.set(sx,3.4,sz); sc.add(cr); }
    else box(0.9,1.3,0.45,hexM(0x5e6a74),sx,0.65,sz); }
  for(const o of H.sheds) box(o.w,2.4,o.d,'--neigh',X(o.x+o.w/2),1.2,Z(o.y+o.d/2));
  for(const t of H.trees){ const tr=new THREE.Mesh(new THREE.CylinderGeometry(0.25,0.3,3,10),mat('--house')); tr.position.set(X(t.x),1.5,Z(t.y)); sc.add(tr);
    const cr=new THREE.Mesh(new THREE.SphereGeometry(t.r+0.4,16,12),mat('--tree')); cr.position.set(X(t.x),4.2,Z(t.y)); sc.add(cr); }
  R3.movCar=null;
  if(r){ const c=new THREE.MeshLambertMaterial({color:new THREE.Color(css(e.status==="g"?'--ok':e.status==="y"?'--warn':'--bad'))}), hgt=RULE.carportH;
    for(const p of postRects(r)) box(p.w,hgt,p.d,c,X(p.x+p.w/2),hgt/2,Z(p.y+p.d/2));
    box(r.w+0.2,0.16,r.d+0.2,new THREE.MeshLambertMaterial({color:c.color,transparent:true,opacity:0.8}),X(r.x+r.w/2),hgt,Z(r.y+r.d/2));
    if(e.acc) e.acc.bays.forEach((Bq,bi)=>{ const car=makeCar(bi===state.bay?0x3d5a80:0x8a8f96);
      if(bi===state.bay){ if(Bq.ok) poseCar(car,finalPose(Bq),W,D); else if(Bq.attempt){ poseCar(car,Bq.attempt.poses[Bq.attempt.hit],W,D); car.children[0].material=new THREE.MeshLambertMaterial({color:0xb3261e}); } else return; R3.movCar=car; }
      else poseCar(car,finalPose(Bq),W,D); sc.add(car); }); }
  R3.scene=sc;
  if(resetCam){ const m=Math.max(W,D); R3.camera.position.set(-m*0.45,m*1.35,m*0.95); R3.controls.target.set(0,0,0); R3.controls.update(); }
  resize3D(); R3.renderer.render(sc,R3.camera); }

// ---------- Drive-in animation ----------
let anim=null;
function stopAnim(){ if(anim){ cancelAnimationFrame(anim.raf); anim=null; } }
function setMsg(t,bad){ const m=$("animmsg"); m.textContent=t; m.classList.toggle("bad",!!bad); }
function playAnim(mode){ stopAnim(); const cur=current();
  if(!cur.e||!cur.e.acc){ setMsg("Nothing to drive: this footprint fails a rule before the vehicle check.",true); return; }
  const B=cur.e.acc.bays[state.bay], other=cur.e.acc.bays.length>1?` with bay ${2-state.bay} occupied`:"";
  let poses, blocked=false, txt="";
  if(mode==="out"){ if(!B.ok){ setMsg("This car never gets in, so there is no way out to show.",true); return; }
    const x=exitFor(cur.H,cur.r,state.bay); poses=x?x.poses:[...B.poses].reverse(); txt=`Out: ${x?x.txt:"reverses along the way in"}${other}.`; }
  else if(B.ok){ poses=B.poses; txt=`In ${B.route.how}${other}.`; }
  else if(B.attempt){ poses=B.attempt.poses.slice(0,B.attempt.hit+1); blocked=true; txt=`Stopped: the car would come within ${fmt(VEH.clr)} m of ${B.attempt.blocker==="car"?"the parked car":"a carport post"}${other}.`; }
  else { setMsg("No route: the car cannot reach this carport with its turning circle and clearance.",true); return; }
  const H=cur.H, W=H.plot.w, D=H.plot.d, SPEED=12, cum=[0];
  for(let i=1;i<poses.length;i++) cum.push(cum[i-1]+Math.hypot(poses[i].x-poses[i-1].x,poses[i].y-poses[i-1].y)+1e-6);
  const total=cum[cum.length-1], ms=total/SPEED*1000;
  const at=s=>{ let lo=0,hi=cum.length-1; while(hi-lo>1){ const m=(lo+hi)>>1; if(cum[m]<=s) lo=m; else hi=m; }
    const f=(s-cum[lo])/((cum[hi]-cum[lo])||1), a=poses[lo], b=poses[hi]; let da=(b.a-a.a)%(2*Math.PI); if(da>Math.PI) da-=2*Math.PI; if(da<-Math.PI) da+=2*Math.PI; return {x:a.x+(b.x-a.x)*f,y:a.y+(b.y-a.y)*f,a:a.a+da*f}; };
  let set;
  if(state.view==="3d"&&R3&&R3.movCar){ set=p=>{ poseCar(R3.movCar,p,W,D); R3.renderer.render(R3.scene,R3.camera); }; }
  else { const svg=$("plan"), sel=$("selcar"); if(sel) sel.style.display="none"; let g=$("movcar"); if(!g){ g=document.createElementNS("http://www.w3.org/2000/svg","g"); g.id="movcar"; g.setAttribute("pointer-events","none"); svg.appendChild(g); }
    g.innerHTML=carBody(css(blocked?'--bad-soft':'--accent-soft'),css(blocked?'--bad':'--accent')); set=p=>g.setAttribute("transform",carTf(p,D)); }
  const finish=()=>{ anim=null; setMsg(txt,blocked); if(mode==="out"){ set(at(total)); } else renderCheck(false,true); };
  if(reduceMotion()){ set(at(total)); finish(); return; }
  setMsg(mode==="out"?`Leaving${other}…`:blocked?`Car tries to drive in${other}…`:`Car drives in${other}…`);
  const start=performance.now();
  const step=now=>{ const t=now-start; if(t>=ms){ set(at(total)); finish(); return; } set(at(t/ms*total)); anim.raf=requestAnimationFrame(step); };
  anim={raf:requestAnimationFrame(step)}; }
$("play").onclick=()=>playAnim("in"); $("play-out").onclick=()=>playAnim("out");
document.querySelectorAll("[data-bay]").forEach(b=>b.onclick=()=>{ state.bay=+b.dataset.bay; stopAnim(); setMsg(""); renderCheck(); });

// ---------- Listing screen ----------
function renderListingPanel(cur){ const H=cur.H;
  $("l-addr").textContent=H.address; $("l-sub").textContent=`${H.village} · ${H.type} · asking ${H.price}`;
  $("l-kv").innerHTML=`<dt>Plot</dt><dd>${fmt(H.plot.w)} × ${fmt(H.plot.d)} m (${Math.round(H.plot.w*H.plot.d)} m²)</dd><dt>House</dt><dd>${fmt(H.house.w)} × ${fmt(H.house.d)} m</dd><dt>Monument</dt><dd>${H.monument?"Yes, listed":"No"}</dd><dt>Driveway exit</dt><dd>${H.exit?`Yes, ${fmt(H.exit.x1-H.exit.x0)} m`:"None"}</dd>`;
  $("l-sheet").href="#sheet-"+H.id;
  document.querySelectorAll("[data-size]").forEach(x=>x.setAttribute("aria-pressed",x.dataset.size===state.size));
  const r=cur.r, o=r?r.o:"ns"; document.querySelectorAll("[data-o]").forEach(x=>x.setAttribute("aria-pressed",x.dataset.o===o));
  if(r&&document.activeElement!==$("in-w")&&document.activeElement!==$("in-d")){ $("in-w").value=fmt(o==="ns"?r.w:r.d); $("in-d").value=fmt(o==="ns"?r.d:r.w); }
  $("reset").hidden=!state.custom;
}
function renderOptList(cur){ const ol=$("optlist");
  ol.innerHTML=`<span class="lbl">Suggested positions:</span>`+cur.opts.map((o,i)=>`<button class="optbtn" aria-pressed="${!cur.custom&&i===state.option}" data-i="${i}"><span class="dot" style="background:var(${o.status==='g'?'--ok':'--warn'})"></span>${i+1} · ${placeName(cur.H,o.r)}</button>`).join("")+
    (cur.custom?`<button class="optbtn" aria-pressed="true"><span class="dot" style="background:var(--accent)"></span>Custom</button>`:"")+(cur.opts.length?"":`<span class="muted" style="font-size:12px">none</span>`);
  ol.querySelectorAll("button[data-i]").forEach(b=>b.onclick=()=>{ state.option=+b.dataset.i; state.custom=null; state.bay=0; stopAnim(); setMsg(""); renderCheck(); }); }
function renderCheck(animateSteps,light){
  if(!light) stopAnim();
  const cur=current(), H=cur.H;
  $("h-plan").textContent=H.address; $("plan-sub").textContent=`${H.village} · plot ${fmt(H.plot.w)} × ${fmt(H.plot.d)} m · carport ${SIZES[state.size].label}`;
  const nb=cur.r?cur.r.bays:SIZES[state.size].bays; $("bayseg").hidden=nb<2; $("baynote").hidden=nb<2; document.querySelectorAll("[data-bay]").forEach(b=>b.setAttribute("aria-pressed",+b.dataset.bay===state.bay));
  $("play").disabled=!cur.r; $("play-out").disabled=!(cur.e&&cur.e.acc&&cur.e.acc.bays[state.bay]&&cur.e.acc.bays[state.bay].ok);
  renderListingPanel(cur); renderOptList(cur); renderPlan(cur); renderResult(cur); renderFlag(cur);
  if(!light) renderSteps(animateSteps);
  if(state.view==="3d") build3D(!!animateSteps&&!light);
}
function openListing(id){ state.house=id; state.option=0; state.custom=null; state.bay=0; setMsg("");
  const H=houseOf(id); $("h-plan").textContent=H.address;
  if(!ready(id,state.size)){ $("busy").hidden=false; setTimeout(()=>{ get(id,state.size); $("busy").hidden=true; renderCheck(true); },30); }
  else renderCheck(true); }
document.querySelectorAll("[data-size]").forEach(b=>b.onclick=()=>{ state.size=b.dataset.size; state.option=0; state.custom=null; state.bay=0; setMsg("");
  if(!ready(state.house,state.size)){ $("busy").hidden=false; setTimeout(()=>{ get(state.house,state.size); $("busy").hidden=true; renderCheck(true); },30); } else renderCheck(true); });
document.querySelectorAll("[data-o]").forEach(b=>b.onclick=()=>{ const cur=current(), H=cur.H, o=b.dataset.o; if(!cur.r) return;
  const width=cur.r.o==="ns"?cur.r.w:cur.r.d, depth=cur.r.o==="ns"?cur.r.d:cur.r.w, w=o==="ns"?width:depth, d=o==="ns"?depth:width;
  state.custom={...cur.r,o,w,d,x:Math.max(0,Math.min(H.plot.w-w,cur.r.x)),y:Math.max(0,Math.min(H.plot.d-d,cur.r.y))}; state.bay=0; renderCheck(); });
function applyDims(){ const cur=current(), H=cur.H; if(!cur.r) return; let width=parseFloat($("in-w").value), depth=parseFloat($("in-d").value); if(!(width>0)||!(depth>0)) return;
  width=Math.max(2.5,Math.min(12,snapG(width))); depth=Math.max(4,Math.min(10,snapG(depth))); const o=cur.r.o, w=o==="ns"?width:depth, d=o==="ns"?depth:width;
  if(w>H.plot.w||d>H.plot.d) return; state.custom={...cur.r,w,d,x:Math.max(0,Math.min(H.plot.w-w,cur.r.x)),y:Math.max(0,Math.min(H.plot.d-d,cur.r.y))}; state.bay=0; renderCheck(); }
$("in-w").addEventListener("change",applyDims); $("in-d").addEventListener("change",applyDims);
$("reset").onclick=()=>{ state.custom=null; state.bay=0; setMsg(""); renderCheck(); };
$("show-yellow").onchange=ev=>{ state.showYellow=ev.target.checked; state.option=0; renderCheck(); };
const setView=v=>{ stopAnim(); state.view=v; $("v2d").setAttribute("aria-pressed",v==="2d"); $("v3d").setAttribute("aria-pressed",v==="3d");
  $("plan").toggleAttribute("hidden",v!=="2d"); $("three").hidden=v!=="3d"; $("hint3d").hidden=v!=="3d";
  if(v==="3d"){ init3D(); build3D(true); } else renderCheck(false,true); };
$("v2d").onclick=()=>setView("2d"); $("v3d").onclick=()=>setView("3d");

// ---------- Listings table ----------
function renderListings(){ $("listing-rows").innerHTML=HOUSES.map(h=>{ const cell=s=>ready(h.id,s)?`<span class="pill ${get(h.id,s).best}">${STATUS_TXT[get(h.id,s).best]}</span>`:`<span class="pill n">Analysing…</span>`;
    return `<tr class="row" data-id="${h.id}" tabindex="0"><td><b>${h.address}</b><div class="muted" style="font-size:12px">${h.village}</div></td><td>${h.type}</td><td class="mono">${h.price}</td><td>${cell("single")}</td><td>${cell("double")}</td><td style="text-align:right"><a class="btn small" href="#listing-${h.id}">Open</a></td></tr>`; }).join("");
  document.querySelectorAll("#listing-rows tr.row").forEach(tr=>{ const open=()=>go("listing-"+tr.dataset.id); tr.onclick=ev=>{ if(ev.target.closest("a")) return; open(); }; tr.onkeydown=ev=>{ if(ev.key==="Enter") open(); }; }); }
// analyse all listings in the background, one at a time, so the page stays responsive
const queue=[]; HOUSES.forEach(h=>["single","double"].forEach(s=>queue.push([h.id,s])));
function pump(){ const n=queue.find(([id,s])=>!ready(id,s)); if(!n) return; get(n[0],n[1]); if(!$("v-listings").hidden) renderListings();  setTimeout(pump,20); }

// ---------- Buyer sheet ----------
function renderSheet(id){ const H=houseOf(id); let txt=`${H.address}, ${H.village}: carport potential\nAsking price ${H.price}\n`;
  $("h-sheet").textContent=`${H.address}, ${H.village}: carport potential`;
  $("sheet-sub").textContent=`Information for prospective buyers · ${H.type} · asking ${H.price} · prepared by Demo makelaardij with VergunBuy`;
  $("sheet-back").href="#listing-"+id;
  const keep={house:state.house,size:state.size,custom:state.custom,bay:state.bay}; state.house=id; state.custom=null; state.bay=0;
  let html="";
  for(const sz of ["single","double"]){ state.size=sz; const res=get(id,sz), o=res.options[0], label=`${sz==="single"?"Single":"Double"} carport (${SIZES[sz].label.split("(")[1].replace(")","")})`;
    if(!o){ html+=`<div class="rh"><div><h2>${label}</h2><span class="pill r">Not feasible</span><p style="font-size:14px">No position of this size passes the checks on this plot.</p></div></div>`; txt+=`\n${label}: not feasible on this plot.\n`; continue; }
    const e=evaluate(H,o.r,true), cur={H,res,opts:[],r:o.r,e,custom:false}, permits=permitsOf(e), conds=e.trace.filter(t=>t.res==="cond"), {s,vb}=planSVG(cur,{mini:true});
    const route=e.acc.bays.map(b=>`${e.acc.bays.length>1?`car ${b.b+1}: `:""}${b.route.txt}`).join("; ");
    html+=`<div class="rh"><div><h2>${label}</h2><span class="pill ${e.status}">${STATUS_TXT[e.status]}</span>
      <dl class="kv"><dt>Best position</dt><dd>${placeName(H,o.r)}</dd><dt>Route in</dt><dd>${route}${e.acc.bays.length>1?", each with the other car parked":""}</dd>
      <dt>Driveway exit</dt><dd>${e.acc.mode==="existing"?"Uses the existing exit":`New exit needed (${fmt(e.acc.exit.w)} m)`}</dd><dt>Permits likely</dt><dd>${permits.length?permits.join("<br>"):"None under the sample rules"}</dd></dl>
      ${conds.length?`<b style="font-size:13px">Why</b><ul>${conds.map(t=>`<li>${t.text}</li>`).join("")}</ul>`:""}
      <p class="noprint" style="margin-top:10px"><a class="btn small" href="#listing-${id}">Open in VergunBuy</a></p></div>
      <svg class="miniplan" viewBox="${vb}" role="img" aria-label="Plot plan with the suggested ${sz} carport and the car's route">${s}</svg></div>`;
    txt+=`\n${label}: ${STATUS_TXT[e.status]}\n  Best position: ${placeName(H,o.r).toLowerCase()}\n  Route in: ${route}\n  Driveway exit: ${e.acc.mode==="existing"?"existing":"new, "+fmt(e.acc.exit.w)+" m"}\n`;
    permits.forEach(p=>txt+=`  Permit: ${p}\n`); }
  Object.assign(state,keep);
  html+=`<div class="rh" style="display:block"><h2>What this is based on</h2><p style="font-size:13px;margin:4px 0">“Potentially permit-free” means the position passes sample rules modelled on Gemeente Woensdrecht. It is an indication, not a permit decision.</p>
    <b style="font-size:13px">Assumed</b><ul>${ASSUMPTIONS.map(a=>`<li>${a[1]}</li>`).join("")}</ul><b style="font-size:13px">Not checked</b><ul>${MISSING.map(a=>`<li>${a[1]}</li>`).join("")}</ul></div>`;
  $("sheet-body").innerHTML=html; txt+=`\nIndicative check based on sample rules and fictional property data. Not legal advice.`; $("sheet-text").value=txt; }
$("sheet-copy").onclick=async()=>{ const t=$("sheet-text"), m=$("sheet-msg");
  try{ await navigator.clipboard.writeText(t.value); m.textContent="Copied"; m.hidden=false; setTimeout(()=>m.hidden=true,1500); } catch(_){ t.hidden=false; t.focus(); t.select(); } };
$("sheet-print").onclick=()=>{ try{ window.print(); } catch(_){ const m=$("sheet-msg"); m.textContent="Printing is blocked here: download the page and print it from your browser."; m.hidden=false; } };

// ---------- Screens ----------
let signedIn=false; try{ signedIn=sessionStorage.getItem("vb-in")==="1"; }catch(_){}
const VIEWS=["login","listings","listing","sheet"];
function show(v){ VIEWS.forEach(n=>$("v-"+n).hidden=n!==v); $("who").hidden=v==="login";
  $("crumb").textContent={login:"For selling agents",listings:"Listings",listing:"Carport potential",sheet:"Buyer information sheet"}[v]; window.scrollTo(0,0); }
let currentHash=""; try{ currentHash=(location.hash||"").slice(1); }catch(_){}
function go(h){ currentHash=h; try{ history.replaceState(null,"","#"+h); }catch(_){} route(); }
document.addEventListener("click",ev=>{ const a=ev.target.closest('a[href^="#"]'); if(!a) return; ev.preventDefault(); go(a.getAttribute("href").slice(1)); });
function route(){ stopAnim(); const h=currentHash; if(!signedIn){ show("login"); return; } let m;
  if((m=h.match(/^listing-([A-Z])$/))){ show("listing"); openListing(m[1]); if(state.view==="3d") setView("3d"); return; }
  if((m=h.match(/^sheet-([A-Z])$/))){ show("sheet"); $("sheet-body").innerHTML=`<p class="muted">Analysing…</p>`; setTimeout(()=>renderSheet(m[1]),30); return; }
  show("listings"); renderListings(); }
function signIn(){ signedIn=true; try{ sessionStorage.setItem("vb-in","1"); }catch(_){} go(currentHash&&currentHash!=="login"?currentHash:"listings"); }
$("signin").onclick=signIn;
["li-email","li-pass"].forEach(id=>$(id).addEventListener("keydown",ev=>{ if(ev.key==="Enter"){ ev.preventDefault(); signIn(); } }));
$("signout").onclick=()=>{ signedIn=false; try{ sessionStorage.removeItem("vb-in"); }catch(_){} go("login"); };
window.addEventListener("hashchange",()=>{ try{ const h=location.hash.slice(1); if(h!==currentHash){ currentHash=h; route(); } }catch(_){} });
route(); setTimeout(pump,50);
