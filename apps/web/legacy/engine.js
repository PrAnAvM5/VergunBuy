// ================= VergunBuy engine (rules + vehicle swept-path check) =================
// Coordinates in metres. x runs along the road, y is depth from the road (y=0 = plot front edge).
const HOUSES = [
  { id:"A", address:"Kastanjelaan 14", village:"Hoogerheide", type:"Detached house", price:"€485,000",
    plot:{w:20,d:34}, house:{x:4,y:8,w:11,d:10,h:6,ridge:9.5},
    sheds:[{x:15.5,y:28,w:3,d:3}], trees:[{x:11,y:30.5,r:2}], monument:false, exit:{x0:0,x1:4},
    street:[{x:9.5,kind:"lamp post"}],
    neighbours:[{x:-13,y:7,w:10,d:10},{x:23,y:9,w:10,d:9}] },
  { id:"B", address:"Molenstraat 7", village:"Ossendrecht", type:"Terraced house", price:"€449,000",
    plot:{w:8.5,d:30}, house:{x:0,y:6.5,w:7,d:11,h:6,ridge:9},
    sheds:[{x:0,y:25,w:3,d:3}], trees:[], monument:false, exit:null,
    street:[{x:7.6,kind:"street tree"}],
    neighbours:[{x:-7,y:6.5,w:7,d:11},{x:8.5,y:6.5,w:7,d:11}] },
  { id:"C", address:"Dorpsweg 3", village:"Huijbergen", type:"Detached house · listed monument", price:"€475,000",
    plot:{w:16,d:28}, house:{x:5,y:7,w:8,d:9,h:5.5,ridge:9},
    sheds:[], trees:[{x:2.4,y:12,r:2}], monument:true, exit:{x0:13,x1:16},
    street:[{x:8,kind:"electricity cabinet"}],
    neighbours:[{x:-12,y:6,w:9,d:9},{x:19,y:8,w:9,d:9}] }
];
// width = across the parking bays, depth = along the car
const SIZES = { single:{width:3,depth:5,bays:1,label:"single (3 × 5 m)"}, double:{width:6,depth:5,bays:2,label:"double (6 × 5 m)"} };
const footprint=(S,o)=>o==="ns"?{w:S.width,d:S.depth}:{w:S.depth,d:S.width};
// Sample rule set modelled on the permit-free rules for annexes (omgevingsplan "bruidsschat" art. 22.27 / 22.36)
// and Woensdrecht's local rules. Values are illustrative.
const RULE = {
  frontBehind:1.0,  // back-yard area (achtererfgebied) starts 1 m behind the front of the main building
  publicDist:1.0,   // annex must be more than 1 m from publicly accessible area
  near:4.0,         // zone "within 4 m of the original main building"
  firstFloor:2.8,   // ASSUMED floor level of the first upper storey
  nearAbove:0.3, farMax:3.0, absMax:5.0,
  carportH:2.6,     // height of the carport being checked
  rootBuffer:1.5,   // tree protection zone: crown + 1.5 m (common practice)
  doorGap:0.5,      // free width beside each parked car to open the doors (assumed)
  exitStd:3.0,      // Woensdrecht driveway exit policy: standard exit 3 m wide
  streetGap:1.0,    // ASSUMED: a new exit keeps 1 m from street furniture and street trees
  step:0.5
};
const streetClash=(H,x0,x1)=>(H.street||[]).find(s=>s.x+RULE.streetGap>x0+1e-9&&s.x-RULE.streetGap<x1-1e-9);
function maxAnnexArea(bg){ if(bg<=100) return 0.5*bg; if(bg<=300) return 50+0.2*(bg-100); return Math.min(150,90+0.1*(bg-300)); }

// ---------- Vehicle model (provisional modelling assumptions from the team's design rules) ----------
// Passenger car 1.8 × 4.5 m, wheelbase 2.7 m, overhang 0.9 m front and rear.
// At full lock the outer front corner sweeps a 6.5 m radius; every part of the body keeps 0.5 m from obstacles.
const VEH = { w:1.8, l:4.5, wb:2.7, fo:0.9, ro:0.9, outerR:6.5, clr:0.5, post:0.1 };
const RT = Math.sqrt(VEH.outerR**2-(VEH.wb+VEH.fo)**2)-VEH.w/2; // turning radius of the rear-axle centre (≈4.51 m)
const HW=3.0, MAXPOPS=400, MAXTURN=4, GS=0.5, Y0=-5, EPS=1e-6, TURNPEN=1.5, Q45=Math.PI/4, C45=Math.SQRT1_2;
const NOSE=VEH.wb+VEH.fo, BODYC=(NOSE-VEH.ro)/2; // nose and body centre ahead of the rear axle

// ---------- Geometry helpers ----------
const overlap=(a,b)=>a.x<b.x+b.w-1e-9&&a.x+a.w>b.x+1e-9&&a.y<b.y+b.d-1e-9&&a.y+a.d>b.y+1e-9;
function circleRectDist(c,r){const cx=Math.max(r.x,Math.min(c.x,r.x+r.w)),cy=Math.max(r.y,Math.min(c.y,r.y+r.d));return Math.hypot(c.x-cx,c.y-cy);}
const fmt=v=>(Math.round(v*10)/10).toFixed(1);
const facade=H=>H.house.y;
function zoneOf(H,r){ if(r.y < facade(H)+RULE.frontBehind) return "front"; if(r.y >= H.house.y+H.house.d) return "back"; return "side"; }
const ZONE_LABEL={front:"Front yard",side:"Side of the house",back:"Back yard"};
const snapG=v=>Math.round(v/GS)*GS, ceilG=v=>Math.ceil(v/GS-1e-9)*GS, floorG=v=>Math.floor(v/GS+1e-9)*GS;
function distRect(a,b){ const dx=Math.max(0,b.x-(a.x+a.w),a.x-(b.x+b.w)), dy=Math.max(0,b.y-(a.y+a.d),a.y-(b.y+b.d)); return Math.hypot(dx,dy); }

// pose = rear-axle centre (x,y) + compass heading a (0 = away from the road, clockwise)
function carCorners(x,y,a){ const s=Math.sin(a), c=Math.cos(a), u0=-VEH.ro, u1=NOSE, v=VEH.w/2;
  return [x+u0*s-v*c, y+u0*c+v*s, x+u1*s-v*c, y+u1*c+v*s, x+u1*s+v*c, y+u1*c-v*s, x+u0*s+v*c, y+u0*c-v*s]; }
function boxHit(cc,x,y,a,b){
  let mnx=Infinity,mxx=-Infinity,mny=Infinity,mxy=-Infinity;
  for(let k=0;k<8;k+=2){ const px=cc[k],py=cc[k+1]; if(px<mnx)mnx=px; if(px>mxx)mxx=px; if(py<mny)mny=py; if(py>mxy)mxy=py; }
  if(mxx<=b.x0+EPS||mnx>=b.x1-EPS||mxy<=b.y0+EPS||mny>=b.y1-EPS) return false;
  const s=Math.sin(a),c=Math.cos(a), bx=[b.x0,b.x1,b.x1,b.x0], by=[b.y0,b.y0,b.y1,b.y1];
  let lo=Infinity,hi=-Infinity; for(let k=0;k<4;k++){ const p=bx[k]*s+by[k]*c; if(p<lo)lo=p; if(p>hi)hi=p; }
  const ad=x*s+y*c; if(hi<=ad-VEH.ro+EPS||lo>=ad+NOSE-EPS) return false;
  lo=Infinity;hi=-Infinity; for(let k=0;k<4;k++){ const p=bx[k]*c-by[k]*s; if(p<lo)lo=p; if(p>hi)hi=p; }
  const ar=x*c-y*s; if(hi<=ar-VEH.w/2+EPS||lo>=ar+VEH.w/2-EPS) return false;
  return true;
}
function circleHit(x,y,a,ci){ const s=Math.sin(a),c=Math.cos(a), dx=ci.x-x, dy=ci.y-y;
  const u=Math.max(-VEH.ro,Math.min(NOSE,dx*s+dy*c)), v=Math.max(-VEH.w/2,Math.min(VEH.w/2,dx*c-dy*s));
  const lu=dx*s+dy*c-u, lv=dx*c-dy*s-v; return Math.hypot(lu,lv)<ci.r-EPS; }
function boundaryHit(H,cc){ const W=H.plot.w, D=H.plot.d, m=VEH.clr;
  for(let k=0;k<8;k+=2){ const px=cc[k],py=cc[k+1]; if(py>EPS&&(px<m-EPS||px>W-m+EPS||py>D-m+EPS)) return true; }
  for(let k=0;k<8;k+=2){ const x1=cc[k],y1=cc[k+1],x2=cc[(k+2)%8],y2=cc[(k+3)%8];
    if((y1>EPS)!==(y2>EPS)&&Math.abs(y2-y1)>EPS){ const xi=x1+(x2-x1)*(0-y1)/(y2-y1); if(xi<m-EPS||xi>W-m+EPS) return true; } }
  return false; }
const inflate=(r,m,kind)=>({x0:r.x-m,y0:r.y-m,x1:r.x+r.w+m,y1:r.y+r.d+m,kind});
function staticObs(H){ return { rects:[H.house,...H.sheds].map((o,i)=>inflate(o,VEH.clr,i?"shed":"house")),
  circles:H.trees.map(t=>({x:t.x,y:t.y,r:t.r+RULE.rootBuffer})) }; }
function staticHit(L,x,y,a){ const cc=carCorners(x,y,a); if(boundaryHit(L.H,cc)) return true;
  for(const b of L.sobs.rects) if(boxHit(cc,x,y,a,b)) return true;
  for(const ci of L.sobs.circles) if(circleHit(x,y,a,ci)) return true; return false; }
function dynHitWhich(dyn,x,y,a){ if(!dyn||!dyn.rects.length) return null;
  const cx=x+BODYC*Math.sin(a), cy=y+BODYC*Math.cos(a), R=2.43;
  if(cx+R<dyn.bb.x0||cx-R>dyn.bb.x1||cy+R<dyn.bb.y0||cy-R>dyn.bb.y1) return null;
  let cc=null; for(const b of dyn.rects){ if(cx+R<b.x0||cx-R>b.x1||cy+R<b.y0||cy-R>b.y1) continue; if(!cc) cc=carCorners(x,y,a); if(boxHit(cc,x,y,a,b)) return b; } return null; }

// ---------- Motion primitives on a 0.5 m lattice with 8 headings ----------
// Turns are circular arcs at the minimum turning radius joined by short straights, so each 45° turn
// ends exactly on the grid: N→NE moves (1.5, 3.5) m. Two of them make a 90° curve.
function walk(p,segs,step=0.25){ const out=[]; let {x,y,a}=p;
  for(const sg of segs){
    if(sg.S!==undefined){ if(sg.S<1e-9) continue; const n=Math.max(1,Math.ceil(sg.S/step)), dx=Math.sin(a)*sg.S/n, dy=Math.cos(a)*sg.S/n;
      for(let i=0;i<n;i++){ x+=dx; y+=dy; out.push({x,y,a}); } }
    else { const ang=sg.A, sgn=Math.sign(ang), n=Math.max(1,Math.ceil(Math.abs(ang)*RT/step)), a0=a;
      const cx=x+sgn*RT*Math.cos(a0), cy=y-sgn*RT*Math.sin(a0);
      for(let i=1;i<=n;i++){ const na=a0+ang*i/n; x=cx-sgn*RT*Math.cos(na); y=cy+sgn*RT*Math.sin(na); a=na; out.push({x,y,a}); } } }
  return out; }
const PRIMS=(()=>{ const s2=(1.5-RT*(1-C45))/C45, s1=3.5-RT*C45-s2*C45;
  const base=[[{segs:[{S:GS}],dh:0},{segs:[{S:s1},{A:Q45},{S:s2}],dh:1},{segs:[{S:s1},{A:-Q45},{S:s2}],dh:-1}],
              [{segs:[{S:GS*Math.SQRT2}],dh:0},{segs:[{S:s2},{A:Q45},{S:s1}],dh:1},{segs:[{S:s2},{A:-Q45},{S:s1}],dh:-1}]];
  const rot=(q,k)=>{ let {x,y,a}=q; for(let i=0;i<k;i++){ const t=x; x=y; y=-t; a+=Math.PI/2; } return {x,y,a}; };
  const out=[]; for(let h=0;h<8;h++){ const b=h&1, k=(h-b)/2;
    out[h]=base[b].map(p=>{ const sm=walk({x:0,y:0,a:b*Q45},p.segs).map(q=>rot(q,k)), e=sm[sm.length-1];
      const len=p.segs.reduce((t,sg)=>t+(sg.S!==undefined?sg.S:Math.abs(sg.A)*RT),0);
      const RX=Math.hypot(NOSE,VEH.w/2); return {bb:{x0:Math.min(0,...sm.map(q=>q.x))-RX,x1:Math.max(0,...sm.map(q=>q.x))+RX,y0:Math.min(0,...sm.map(q=>q.y))-RX,y1:Math.max(0,...sm.map(q=>q.y))+RX},di:Math.round(e.x/GS),dj:Math.round(e.y/GS),dh:p.dh,samples:sm,cost:len+(p.dh?TURNPEN:0),len,err:Math.hypot(e.x-Math.round(e.x/GS)*GS,e.y-Math.round(e.y/GS)*GS)}; }); }
  return out; })();
const HEADA=h=>h*Q45;

class Heap{ constructor(){this.k=[];this.v=[];} get size(){return this.v.length;}
  push(key,val){ const k=this.k,v=this.v; let i=v.length; k.push(key); v.push(val); while(i>0){ const p=(i-1)>>1; if(k[p]<=key) break; k[i]=k[p]; v[i]=v[p]; i=p; } k[i]=key; v[i]=val; }
  pop(){ const k=this.k,v=this.v, top=v[0], lk=k.pop(), lv=v.pop(), n=v.length;
    if(n){ let i=0; for(;;){ let l=2*i+1; if(l>=n) break; const r=l+1; if(r<n&&k[r]<k[l]) l=r; if(k[l]>=lk) break; k[i]=k[l]; v[i]=v[l]; i=l; } k[i]=lk; v[i]=lv; }
    return top; } }

// Lattice per house: static collision results are cached and shared by all searches.
const LAT={};
function latOf(H){
  if(LAT[H.id]) return LAT[H.id];
  const NI=Math.round(H.plot.w/GS)+1, NJ=Math.round((H.plot.d-Y0)/GS)+1, N=NI*NJ*8;
  const L={H,NI,NJ,N,node:new Uint8Array(N),edge:new Uint8Array(N*3),sobs:staticObs(H)};
  L.startAny=x=>!streetClash(H,x-VEH.w/2-VEH.clr,x+VEH.w/2+VEH.clr); L.startFree=x=>true;
  L.startExisting=x=>!!H.exit&&x-VEH.w/2-VEH.clr>=H.exit.x0-EPS&&x+VEH.w/2+VEH.clr<=H.exit.x1+EPS;
  L.res={any:search(L,L.startAny,null,null)}; if(H.exit) L.res.existing=search(L,L.startExisting,null,null); if((H.street||[]).length) L.res.free=search(L,L.startFree,null,null);
  LAT[H.id]=L; return L;
}
const stXY=(L,s)=>{ const k=s>>3; return [(k%L.NI)*GS, Y0+((k/L.NI)|0)*GS]; };
const stOf=(L,x,y,h)=>((Math.round((y-Y0)/GS)*L.NI)+Math.round(x/GS))*8+h;
function nodeOk(L,s,dyn){ if(!L.node[s]){ const [x,y]=stXY(L,s); L.node[s]=staticHit(L,x,y,HEADA(s&7))?2:1; }
  if(L.node[s]===2) return false; if(dyn){ const [x,y]=stXY(L,s); if(dynHitWhich(dyn,x,y,HEADA(s&7))) return false; } return true; }
function edgeOk(L,s,p,x,y,P,dyn){ const e=s*3+p;
  if(!L.edge[e]){ let bad=false; for(const q of P.samples){ if(staticHit(L,x+q.x,y+q.y,q.a)){ bad=true; break; } } L.edge[e]=bad?2:1; }
  if(L.edge[e]===2) return false;
  if(dyn&&!(x+P.bb.x1<dyn.bb.x0||x+P.bb.x0>dyn.bb.x1||y+P.bb.y1<dyn.bb.y0||y+P.bb.y0>dyn.bb.y1)) for(const q of P.samples) if(dynHitWhich(dyn,x+q.x,y+q.y,q.a)) return false;
  return true; }
// Shortest-route search (Dijkstra; A* towards the goals when given). The car leaves the road driving straight
// and may only start turning once its rear axle is on the plot.
function search(L,startOk,dyn,goals){
  const {NI,NJ,N}=L, dist=new Float32Array(N).fill(Infinity), par=new Int32Array(N).fill(-1), pr=new Int8Array(N).fill(-1), done=new Uint8Array(N);
  // goals lie on one straight approach line: heuristic = distance to that segment
  let g0=null,g1=null; if(goals){ const pts=[...goals.keys()].map(s=>stXY(L,s)); g0=pts[0]; g1=pts[pts.length-1]; }
  const gx=g0?g1[0]-g0[0]:0, gy=g0?g1[1]-g0[1]:0, gl2=gx*gx+gy*gy;
  const hf=s=>{ if(!g0) return 0; const k=s>>3, x=(k%NI)*GS-g0[0], y=Y0+((k/NI)|0)*GS-g0[1]; const t=gl2?Math.max(0,Math.min(1,(x*gx+y*gy)/gl2)):0; return Math.hypot(x-t*gx,y-t*gy)*HW; };
  const heap=new Heap();
  for(let i=0;i<NI;i++){ if(!startOk(i*GS)) continue; const s=i*8; if(!nodeOk(L,s,dyn)) continue; dist[s]=0; heap.push(hf(s),s); }
  let pops=0;
  while(heap.size){ const s=heap.pop(); if(done[s]) continue; done[s]=1;
    if(goals){ if(goals.has(s)) return {dist,par,pr,goal:s}; if(++pops>MAXPOPS) break; }
    const h=s&7, k=s>>3, i=k%NI, j=(k/NI)|0, x=i*GS, y=Y0+j*GS, prims=PRIMS[h];
    for(let p=0;p<3;p++){ const P=prims[p];
      if(y<0&&P.dh!==0) continue;
      const ni=i+P.di, nj=j+P.dj; if(ni<0||ni>=NI||nj<0||nj>=NJ) continue;
      const nh=(h+P.dh+8)&7; if(Y0+nj*GS<0&&nh!==0) continue;
      const ns=(nj*NI+ni)*8+nh; if(done[ns]) continue;
      if(!edgeOk(L,s,p,x,y,P,dyn)) continue;
      const nd=dist[s]+P.cost; if(nd<dist[ns]-1e-9){ dist[ns]=nd; par[ns]=s; pr[ns]=p; heap.push(nd+hf(ns),ns); } } }
  return {dist,par,pr,goal:-1};
}
function extract(L,res,s){ const chain=[]; let q=s; while(res.par[q]>=0){ chain.push([res.par[q],res.pr[q]]); q=res.par[q]; }
  chain.reverse(); const [x0,y0]=stXY(L,q); const poses=[{x:x0,y:y0,a:0}], turns=[];
  for(const [ps,p] of chain){ const [x,y]=stXY(L,ps), P=PRIMS[ps&7][p]; for(const sm of P.samples) poses.push({x:x+sm.x,y:y+sm.y,a:sm.a}); if(P.dh) turns.push(P.dh); }
  return {poses,turns}; }

// ---------- Carport geometry: bays, parked cars, posts ----------
function baysOf(H,r){ const n=r.bays, ns=r.o==="ns", A0=ns?r.x:r.y, A=ns?r.w:r.d, bw=A/n, out=[];
  for(let b=0;b<n;b++){ const c=snapG(A0+bw*(b+0.5)), E=[];
    if(ns){ E.push({h:0,Af:{x:c,y:ceilG(r.y+VEH.ro)}}); if(zoneOf(H,r)!=="front") E.push({h:4,Af:{x:c,y:floorG(r.y+r.d-VEH.ro)}}); }
    else { E.push({h:2,Af:{x:ceilG(r.x+VEH.ro),y:c}}); E.push({h:6,Af:{x:floorG(r.x+r.w-VEH.ro),y:c}}); }
    out.push({b,c,lo:A0+bw*b,hi:A0+bw*(b+1),entries:E}); }
  return out; }
function carRectAt(x,y,a){ const cc=carCorners(x,y,a); const xs=[cc[0],cc[2],cc[4],cc[6]], ys=[cc[1],cc[3],cc[5],cc[7]];
  const x0=Math.min(...xs), y0=Math.min(...ys); return {x:x0,y:y0,w:Math.max(...xs)-x0,d:Math.max(...ys)-y0}; }
const parkedRect=E=>carRectAt(E.Af.x,E.Af.y,HEADA(E.h));
function postRects(r){ const P=VEH.post; return [[r.x,r.y],[r.x+r.w-P,r.y],[r.x,r.y+r.d-P],[r.x+r.w-P,r.y+r.d-P]].map(([x,y])=>({x,y,w:P,d:P})); }
const inside=(cc,r)=>{ for(let k=0;k<8;k+=2) if(cc[k]<r.x-EPS||cc[k]>r.x+r.w+EPS||cc[k+1]<r.y-EPS||cc[k+1]>r.y+r.d+EPS) return false; return true; };
// memoised static check for poses on the 0.25 m approach lines
function lineStatic(L,x,y,h){ if(!L.lm){ L.LI=Math.round(L.H.plot.w/0.25)+1; L.LJ=Math.round((L.H.plot.d-Y0)/0.25)+1; L.lm=new Uint8Array(L.LI*L.LJ*8); }
  const k=((Math.round((y-Y0)/0.25)*L.LI)+Math.round(x/0.25))*8+h; if(!L.lm[k]) L.lm[k]=staticHit(L,x,y,HEADA(h))?2:1; return L.lm[k]===2; }
// Approach line: the car must be straight and lined up before its nose enters the carport.
function approachCands(L,r,E,dyn){ const a=HEADA(E.h), dx=Math.round(Math.sin(a)), dy=Math.round(Math.cos(a)), H=L.H;
  const entryAlong=E.h===0?r.y-E.Af.y:E.h===4?E.Af.y-(r.y+r.d):E.h===2?r.x-E.Af.x:E.Af.x-(r.x+r.w);
  const kmin=Math.ceil((NOSE-entryAlong)/GS-1e-9), out=[]; let dynOk=true, blocker=null;
  for(let t=0;;t+=0.25){ const px=E.Af.x-dx*t, py=E.Af.y-dy*t;
    if(px<-EPS||px>H.plot.w+EPS||py<Y0-EPS||py>H.plot.d+EPS) break;
    if(py<-EPS&&E.h!==0) break;
    if(lineStatic(L,px,py,E.h)&&!inside(carCorners(px,py,a),r)) break;
    const hit=dynHitWhich(dyn,px,py,a); if(hit&&dynOk){ dynOk=false; blocker=hit; }
    const k=Math.round(t/GS); if(Math.abs(t-k*GS)<1e-9&&k>=kmin) out.push({k,s:stOf(L,px,py,E.h),ok:dynOk,E,blocker});
  }
  return out; }
// S-bend lead-ins: lets the car shift sideways 0.5–2.5 m with two gentle arcs just before the straight approach
// (the 45° lattice alone can only shift 3 m or more).
function sCands(L,r,E,dyn,straight){
  const a=HEADA(E.h), dx=Math.round(Math.sin(a)), dy=Math.round(Math.cos(a)), nx=dy, ny=-dx, H=L.H, out=[];
  for(const c of straight.filter(c=>c.ok).slice(0,9)){ if((c.k-straight[0].k)%2) continue;
    const Px=E.Af.x-dx*c.k*GS, Py=E.Af.y-dy*c.k*GS;
    for(const dl of [0.5,1,1.5,2,2.5]) for(const sg of [1,-1]){ const dd=dl*sg, phi=Math.acos(1-dl/(2*RT)), Ls=2*RT*Math.sin(phi), Lg=Math.ceil(Ls/GS-1e-9)*GS;
      const Qx=Px-dx*Lg+nx*dd, Qy=Py-dy*Lg+ny*dd; if(Qx<-EPS||Qx>H.plot.w+EPS||Qy<Y0-EPS||Qy>H.plot.d+EPS||(Qy<0&&E.h!==0)) continue;
      const pre=walk({x:Qx,y:Qy,a},[{S:Lg-Ls},{A:-sg*phi},{A:sg*phi}]); const end=pre[pre.length-1];
      if(Math.hypot(end.x-Px,end.y-Py)>0.02) continue; pre[pre.length-1]={x:Px,y:Py,a};
      if(Qy<0) continue; // turning only once the rear axle is on the plot
      if(pre.some(p=>!inside(carCorners(p.x,p.y,p.a),r)&&staticHit(L,p.x,p.y,p.a))||dynFirstHit(pre,dyn)) continue;
      out.push({k:c.k,s:stOf(L,Qx,Qy,E.h),ok:true,E,pre,extra:Lg+2*RT*phi-Ls+2*TURNPEN*0.5,turns:[-sg,sg]}); } }
  return out; }
function lineFrom(E,k){ const a=HEADA(E.h), dx=Math.round(Math.sin(a)), dy=Math.round(Math.cos(a)), out=[];
  for(let t=k*GS-0.25;t>-1e-9;t-=0.25) out.push({x:E.Af.x-dx*t,y:E.Af.y-dy*t,a}); return out; }
function dynFirstHit(poses,dyn){ for(let i=0;i<poses.length;i++){ const b=dynHitWhich(dyn,poses[i].x,poses[i].y,poses[i].a); if(b) return {i,b}; } return null; }
function exitRange(poses){ let lo=Infinity,hi=-Infinity;
  for(const p of poses){ const cc=carCorners(p.x,p.y,p.a);
    for(let k=0;k<8;k+=2){ const x1=cc[k],y1=cc[k+1],x2=cc[(k+2)%8],y2=cc[(k+3)%8];
      if((y1>0)!==(y2>0)){ const xi=x1+(x2-x1)*(0-y1)/(y2-y1); lo=Math.min(lo,xi); hi=Math.max(hi,xi); } } }
  return lo<hi?{x0:lo-VEH.clr,x1:hi+VEH.clr}:null; }
function describeRoute(turns){ const g=[]; for(const t of turns){ if(g.length&&g[g.length-1].s===t) g[g.length-1].n++; else g.push({s:t,n:1}); }
  const txt=!g.length?"straight":g.length===1?`one ${g[0].n*45}° curve`:g.length===2&&g[0].s!==g[1].s&&g[0].n===g[1].n?"an S-bend":`${g.length} curves`;
  return {txt,how:g.length?`with ${txt}`:"straight",curves:g.length}; }

// Route for one bay through one entry side, in one mode ("existing" exit or "any" new exit)
function bayRoute(L,mode,r,E,dyn,cands){
  const res=L.res[mode], H=L.H; let best=null;
  const tryList=list=>{ const order=list.filter(c=>c.ok&&res.dist[c.s]<Infinity).map(c=>({c,tot:res.dist[c.s]+c.k*GS+(c.extra||0)})).sort((a,b)=>a.tot-b.tot);
    for(const {c,tot} of order){ const p=extract(L,res,c.s); if(dynFirstHit(p.poses,dyn)) continue; if(p.turns.length+(c.turns||[]).length>MAXTURN) continue; return {tot,c,p}; } return null; };
  best=tryList(cands);
  if(!best){ if(!cands._s) cands._s=sCands(L,r,E,dyn,cands); best=tryList(cands._s); }
  const all=cands.concat(cands._s||[]);
  if(!best&&all.some(c=>c.ok&&res.dist[c.s]<Infinity)){ // parked car or posts in the way: search again around them
    const goals=new Map(); all.forEach(c=>{ if(c.ok&&!goals.has(c.s)) goals.set(c.s,c); });
    const r2=search(L,mode==="existing"?L.startExisting:mode==="free"?L.startFree:L.startAny,dyn,goals);
    if(r2.goal>=0){ const c=goals.get(r2.goal); best={tot:r2.dist[r2.goal]+c.k*GS+(c.extra||0),c,p:extract(L,r2,r2.goal)}; } }
  if(!best) return null;
  const turns=best.p.turns.concat(best.c.turns||[]); if(turns.length>MAXTURN) return null; // keep routes simple: at most 180° of turning in total
  const poses=best.p.poses.concat(best.c.pre||[],lineFrom(E,best.c.k)), ex=exitRange(poses);
  if(mode==="existing"&&!(ex&&ex.x0>=H.exit.x0-EPS&&ex.x1<=H.exit.x1+EPS)) return null;
  if(mode==="any"&&ex&&streetClash(H,ex.x0,ex.x1)) return null;
  return {ok:true,mode,poses,E,cost:best.tot,len:best.tot-turns.length*TURNPEN,route:describeRoute(turns),exit:ex};
}
// Best attempt ignoring the parked car and posts (to show where it gets stuck)
function bayAttempt(L,r,E,dyn){ const res=L.res.any, cands=approachCands(L,r,E,null); let best=null;
  for(const c of cands){ const d=res.dist[c.s]; if(d<Infinity&&(!best||d+c.k*GS<best.tot)) best={tot:d+c.k*GS,c}; }
  if(!best) return null; const poses=extract(L,res,best.c.s).poses.concat(lineFrom(E,best.c.k)), h=dynFirstHit(poses,dyn);
  return h?{poses,hit:h.i,blocker:h.b.kind}:null; }

const accCache={};
function accessFor(H,r,full){
  const key=`${H.id}|${r.x}|${r.y}|${r.w}|${r.d}|${r.o}|${r.bays}`; const cached=accCache[key]; if(cached&&(cached.full||!full)) return cached;
  const L=latOf(H), bays=baysOf(H,r), posts=postRects(r).map(p=>inflate(p,VEH.clr,"post"));
  const parked=bays.map(B=>inflate(parkedRect(B.entries[0]),VEH.clr,"car"));
  const out=bays.map((B,bi)=>{ const rects=[...posts,...parked.filter((_,k)=>k!==bi)];
    const dyn={rects,bb:{x0:Math.min(...rects.map(q=>q.x0)),y0:Math.min(...rects.map(q=>q.y0)),x1:Math.max(...rects.map(q=>q.x1)),y1:Math.max(...rects.map(q=>q.y1))}};
    const cl=B.entries.map(E=>approachCands(L,r,E,dyn));
    for(const mode of ["existing","any"]){ if(!L.res[mode]) continue; let best=null;
      B.entries.forEach((E,ei)=>{ const rt=bayRoute(L,mode,r,E,dyn,cl[ei]); if(rt&&(!best||rt.cost<best.cost)) best=rt; });
      if(best) return {...best,b:bi,B}; }
    let attempt=null; if(full) for(const E of B.entries){ attempt=bayAttempt(L,r,E,dyn); if(attempt) break; }
    let street=null; if(L.res.free) B.entries.forEach((E,ei)=>{ if(street) return; const rt=bayRoute(L,"free",r,E,dyn,cl[ei]); if(rt&&rt.exit) street=streetClash(H,rt.exit.x0,rt.exit.x1)||null; });
    return {ok:false,b:bi,B,attempt,street,E:B.entries[0]}; });
  const okB=out.filter(b=>b.ok); let mode="none", exit=null;
  if(okB.length===out.length){ const x0=Math.min(...okB.map(b=>b.exit.x0)), x1=Math.max(...okB.map(b=>b.exit.x1));
    exit={x0,x1,w:x1-x0}; mode=H.exit&&x0>=H.exit.x0-EPS&&x1<=H.exit.x1+EPS?"existing":"new"; }
  const res={bays:out,mode,exit,full:!!full}; accCache[key]=res; return res;
}
const finalPose=B=>B.ok?B.poses[B.poses.length-1]:{x:B.E.Af.x,y:B.E.Af.y,a:HEADA(B.E.h)};

const SRC={
  plan:"Omgevingsplan Woensdrecht, art. 22.27 (permit-free annexes)",
  area:"Omgevingsplan Woensdrecht, art. 22.36",
  height:"Omgevingsplan Woensdrecht, art. 22.36",
  zoning:"Sample data: zoning of this fictional plot",
  monument:"Omgevingsplan Woensdrecht, art. 22.28: permit-free rules do not apply at a monument",
  front:"Omgevingsplan Woensdrecht, art. 22.27: only the back-yard area is permit-free",
  tree:"Woensdrecht Bomenlijst (APV art. 4:11, now in the omgevingsplan); protection zone crown + 1.5 m assumed",
  exit:"Woensdrecht: uitwegvergunning (APV art. 2:12); policy: standard exit 3 m wide",
  exit2:"Woensdrecht APV art. 2:12: a permit can be refused if the plot already has an exit",
  street:"Woensdrecht APV art. 2:12 (refusal grounds: safety and public space); 1 m distance assumed",
  civil:"Dutch Civil Code art. 5:52",
  car:"Team design rule (provisional): outer swept radius 6.5 m, 0.5 m clearance",
  bbl:"Besluit bouwwerken leefomgeving (Bbl)"
};
const ASSUMPTIONS=[
  ["Vehicle","A passenger car of 1.8 × 4.5 m. At full lock its outer corner sweeps a 6.5 m radius; it keeps 0.5 m from every obstacle.",SRC.car]
];
const MISSING=[
  ["Underground","Cables, pipes and sewer connections under the carport or driveway."],
  ["Legal","Permit history of the house and private agreements such as easements (erfdienstbaarheden)."],
  ["Municipality","Whether the municipality grants a new driveway exit; this is partly its own decision."],
  ["Road","Turning off and onto the street."]
];

// Evaluate one footprint → {status, trace, zone, acc, nCond}
function evaluate(H,r,full){
  const t=[]; let fail=false, cond=false, nCond=0;
  const add=(cat,res,text,src)=>{ t.push({cat,res,text,src}); if(res==="fail")fail=true; if(res==="cond"){cond=true;nCond++;} };
  if(full) ASSUMPTIONS.forEach(([c,x,s])=>add(c,"assume",x,s));
  if(H.monument) add("Heritage","cond","The house is a listed monument (rijksmonument): a carport on this plot needs an omgevingsvergunning.",SRC.monument);
  else add("Heritage","pass","Not a listed monument (sample data).",SRC.monument);
  for(const tr of H.trees){ const d=circleRectDist(tr,r);
    if(d<tr.r+RULE.rootBuffer) add("Trees","fail",`Inside the protection zone of a tree on the municipal Bomenlijst (${fmt(tr.r+RULE.rootBuffer)} m from the trunk kept free).`,SRC.tree);
    else add("Trees","pass","Outside the protection zone of the listed tree (Bomenlijst).",SRC.tree); }
  if(!H.trees.length) add("Trees","pass","No trees from the municipal Bomenlijst on this plot (sample data).",SRC.tree);
  if(r.x<-1e-9||r.y<-1e-9||r.x+r.w>H.plot.w+1e-9||r.y+r.d>H.plot.d+1e-9) add("Placement","fail","Partly outside the plot.");
  if([H.house,...H.sheds].some(o=>overlap(r,o))) add("Placement","fail","Overlaps the house or an existing shed.");
  const z=zoneOf(H,r);
  if(z==="front") add("Position","cond",`In front of the back-yard area (which starts ${fmt(RULE.frontBehind)} m behind the front of the house): not permit-free.`,SRC.front);
  else add("Position","pass",`In the back-yard area (achtererfgebied), at least ${fmt(RULE.frontBehind)} m behind the front of the house.`,SRC.plan);
  if(r.y<=RULE.publicDist+1e-9) add("Position","cond",`Within ${fmt(RULE.publicDist)} m of the public road: not permit-free.`,SRC.plan);
  else add("Position","pass",`More than ${fmt(RULE.publicDist)} m from the public road.`,SRC.plan);
  const sideDist=Math.min(r.x,H.plot.w-(r.x+r.w));
  if(sideDist<1-1e-9) add("Position","note",`${fmt(Math.max(0,sideDist))} m from the neighbour's boundary. Allowed, but rainwater from the roof may not drain onto the neighbour's plot.`,SRC.civil);
  const dh=distRect(r,H.house);
  if(dh<=RULE.near){ const lim=Math.min(RULE.absMax,RULE.firstFloor+RULE.nearAbove);
    add("Height",RULE.carportH<=lim?"pass":"cond",`${fmt(dh)} m from the house: max ${fmt(lim)} m (0.3 m above the first-floor level). Carport ${fmt(RULE.carportH)} m.`,SRC.height); }
  else add("Height",RULE.carportH<=RULE.farMax?"pass":"cond",`More than ${fmt(RULE.near)} m from the house: max ${fmt(RULE.farMax)} m with a flat roof. Carport ${fmt(RULE.carportH)} m.`,SRC.height);
  if(z!=="front"){ const bs=backyardStats(H,r), tot=bs.existing+bs.carport;
    add("Area",tot<=bs.max?"pass":"cond",`Annexes in the back-yard area: ${Math.round(bs.existing)} m² existing + ${Math.round(bs.carport)} m² carport = ${Math.round(tot)} m², max ${Math.round(bs.max)} m² for a ${Math.round(bs.bg)} m² building area.`,SRC.area); }
  // parking space inside the footprint
  const bays=baysOf(H,r), ns=r.o==="ns", A0=ns?r.x:r.y, A1=A0+(ns?r.w:r.d), depth=ns?r.d:r.w;
  const cs=bays.map(B=>B.c).sort((a,b)=>a-b), gaps=[cs[0]-VEH.w/2-A0,...cs.slice(1).map((c,i)=>c-cs[i]-VEH.w),A1-cs[cs.length-1]-VEH.w/2], gap=Math.min(...gaps);
  const E0=bays[0].entries[0], cc=carCorners(E0.Af.x,E0.Af.y,HEADA(E0.h)), fits=inside(cc,r)&&depth>=VEH.l;
  if(!fits) add("Parking","fail",`A ${fmt(VEH.w)} × ${fmt(VEH.l)} m car does not fit inside this footprint.`,SRC.car);
  else add("Parking",gap>=RULE.doorGap-1e-9?"pass":"fail",bays.length>1?`Two cars fit side by side, with at least ${fmt(gap)} m beside each car to open the doors (min ${fmt(RULE.doorGap)} m).`:`The car fits, with at least ${fmt(gap)} m on each side to open the doors (min ${fmt(RULE.doorGap)} m).`,SRC.car);
  let acc=null;
  if(fail){ add("Vehicle access","note","Not checked: the footprint already fails a rule above."); }
  else { acc=accessFor(H,r,full); const nb=acc.bays.length;
    if(acc.mode==="none"){ const blocked=acc.bays.find(b=>!b.ok&&b.attempt), st=acc.bays.find(b=>!b.ok&&b.street);
      const who=nb>1?(acc.bays.filter(b=>!b.ok).length>1?"Neither car":`The car for bay ${acc.bays.find(b=>!b.ok).b+1}`):"The car";
      const neg=who==="Neither car"?"Neither car can":`${who} cannot`;
      if(st&&!blocked) add("Driveway exit","fail",`The only way in crosses the pavement at the ${st.street.kind}: a new exit must keep ${fmt(RULE.streetGap)} m from it, so the municipality would refuse it.`,SRC.street);
      else add("Vehicle access","fail",blocked?`${neg} drive in${nb>1?" while the other bay is occupied":""}: ${who==="Neither car"?"the":"its"} swept path would come within ${fmt(VEH.clr)} m of ${blocked.attempt.blocker==="car"?"the parked car":"a carport post"}.`:
        `${neg} reach the carport: there is no route where the whole body keeps ${fmt(VEH.clr)} m from buildings, trees and boundaries with a 6.5 m outer turning radius, and lines up straight before entering.`,SRC.car); }
    else { acc.bays.forEach(b=>{ add("Vehicle access","pass",`${nb>1?`Bay ${b.b+1}: the car drives in ${b.route.how} while bay ${2-b.b} is occupied`:`The car drives in ${b.route.how}`} (about ${Math.round(b.len)} m), keeping ${fmt(VEH.clr)} m from ${obstacleList(H,nb)}, and enters the bay straight. It can always leave by reversing along the same path.`,SRC.car); });
      if(acc.mode==="existing") add("Driveway exit","pass","Uses the existing driveway exit onto the road.",SRC.exit);
      else { add("Driveway exit","cond","Needs a new driveway exit onto the road: uitwegvergunning from the municipality.",SRC.exit);
        if(acc.exit.w>RULE.exitStd+1e-6) add("Driveway exit","cond",`The car's swept path needs an exit of ${fmt(acc.exit.w)} m, wider than Woensdrecht's standard ${fmt(RULE.exitStd)} m: needs a justification.`,SRC.exit);
        if(H.exit) add("Driveway exit","cond","The plot already has a driveway exit, so a second one can be refused.",SRC.exit2);
        const sc=streetClash(H,acc.exit.x0,acc.exit.x1);
        if(sc) add("Driveway exit","fail",`The new exit would include the ${sc.kind} on the pavement (keep ${fmt(RULE.streetGap)} m), so the municipality would refuse it.`,SRC.street);
        else for(const s of H.street||[]) add("Driveway exit","pass",`The new exit keeps at least ${fmt(RULE.streetGap)} m from the ${s.kind}.`,SRC.street); } } }
  if(full){ add("Technical","note","Building-technical rules (structure, fire safety) still apply, also when no permit is needed.",SRC.bbl);
    MISSING.forEach(([c,x])=>add(c,"missing",x)); }
  return {status:fail?"r":cond?"y":"g",trace:t,zone:z,sideDist,acc,nCond};
}
function obstacleList(H,nb){ const o=["the house"]; if(H.sheds.length) o.push("the shed"); if(H.trees.length) o.push("the tree's root zone"); o.push("the plot boundaries","the carport posts"); if(nb>1) o.push("the parked car");
  return o.slice(0,-1).join(", ")+" and "+o[o.length-1]; }
function backyardStats(H,r){
  const lineY=facade(H)+RULE.frontBehind, h=H.house;
  const houseBehind=Math.max(0,h.y+h.d-Math.max(h.y,lineY))*h.w;
  const bg=H.plot.w*(H.plot.d-lineY)-houseBehind;
  const existing=H.sheds.reduce((a,o)=>a+o.w*o.d,0), carport=r.w*r.d;
  return {bg,existing,carport,max:maxAnnexArea(bg)};
}

// Analyse every position on the 0.5 m grid, both orientations → options + shaded cells
function analyse(H,sizeKey){
  const S=SIZES[sizeKey], res={tested:0,g:0,y:0,r:0,placements:[],failReasons:{front:{},side:{},back:{}},size:sizeKey};
  for(const o of ["ns","ew"]){ const fp=footprint(S,o);
    for(let x=0;x<=H.plot.w-fp.w+1e-9;x+=RULE.step) for(let y=0;y<=H.plot.d-fp.d+1e-9;y+=RULE.step){
      const r={x:Math.round(x*2)/2,y:Math.round(y*2)/2,w:fp.w,d:fp.d,o,bays:S.bays}; res.tested++;
      const e=evaluate(H,r,false); res[e.status]++;
      if(e.status!=="r") res.placements.push({r,status:e.status,zone:e.zone,side:e.sideDist,nCond:e.nCond,cost:Math.max(...e.acc.bays.map(b=>b.cost))});
      else { const fails=e.trace.filter(i=>i.res==="fail"); const f=fails.find(i=>i.cat!=="Placement")||fails[0];
        if(!res.blockedEx&&S.bays>1&&f.cat==="Vehicle access"&&e.acc&&e.acc.bays.some(b=>b.ok)&&(res._tries=(res._tries||0)+1)<=400){
          const a=accessFor(H,r,true); if(a.bays.some(b=>!b.ok&&b.attempt&&b.attempt.blocker==="car")) res.blockedEx=r; }
        const key=f.cat==="Placement"?"No room: overlaps the house or an existing shed":f.cat==="Vehicle access"?"The car cannot get there with its turning circle and clearance":f.text.split(":")[0].split("(")[0].trim();
        const fr=res.failReasons[e.zone]; fr[key]=(fr[key]||0)+(f.cat==="Placement"?0.001:1); } } }
  const cw=Math.round(H.plot.w/RULE.step), cd=Math.round(H.plot.d/RULE.step), cells=new Uint8Array(cw*cd);
  for(const p of res.placements){ const v=p.status==="g"?2:1;
    for(let i=Math.round(p.r.x/RULE.step);i<Math.round((p.r.x+p.r.w)/RULE.step);i++) for(let j=Math.round(p.r.y/RULE.step);j<Math.round((p.r.y+p.r.d)/RULE.step);j++){ const k=j*cw+i; if(cells[k]<v) cells[k]=v; } }
  res.cells={cw,cd,data:cells};
  const zOrder={side:0,back:1,front:2};
  const sorted=[...res.placements].sort((a,b)=>(a.status===b.status?0:a.status==="g"?-1:1)||a.nCond-b.nCond||zOrder[a.zone]-zOrder[b.zone]||a.cost-b.cost||b.side-a.side||a.r.y-b.r.y||a.r.x-b.r.x);
  const picked=[], perZone={front:0,side:0,back:0}, pad=r=>({x:r.x-.5,y:r.y-.5,w:r.w+1,d:r.d+1});
  for(const pass of [2,6]) for(const p of sorted){ if(picked.length>=6) break; if(picked.includes(p)||perZone[p.zone]>=pass) continue;
    if(picked.some(q=>overlap(pad(q.r),p.r))) continue; picked.push(p); perZone[p.zone]++; }
  picked.sort((a,b)=>(a.status===b.status?0:a.status==="g"?-1:1)||zOrder[a.zone]-zOrder[b.zone]);
  res.options=picked; res.best=res.g?"g":res.y?"y":"r";
  return res;
}

// ---------- Leaving: reverse out of the bay, then (where there is room) turn and drive forward to the road ----------
// Display only: leaving is always possible by reversing along the entry path, so this doesn't change feasibility.
const RVC=6, GEAR=4, REV=(()=>{ const out=[...Array(8)].map(()=>[]); for(let h=0;h<8;h++) for(let p=0;p<3;p++) out[(h+PRIMS[h][p].dh+8)&7].push([h,p]); return out; })();
const exitCache={};
const exitKey=(H,r,bi)=>`${H.id}|${r.x}|${r.y}|${r.w}|${r.d}|${r.o}|${r.bays}|${bi}`, exitReady=(H,r,bi)=>exitKey(H,r,bi) in exitCache;
function exitFor(H,r,bi){
  const key=exitKey(H,r,bi); if(key in exitCache) return exitCache[key];
  const acc=accessFor(H,r,true), B=acc.bays[bi]; if(!B||!B.ok||!acc.exit){ exitCache[key]=null; return null; }
  const L=latOf(H), posts=postRects(r).map(p=>inflate(p,VEH.clr,"post")), others=acc.bays.filter((_,k)=>k!==bi).map(q=>inflate(carRectAt(finalPose(q).x,finalPose(q).y,finalPose(q).a),VEH.clr,"car"));
  const rects=[...posts,...others], dyn={rects,bb:{x0:Math.min(...rects.map(q=>q.x0)),y0:Math.min(...rects.map(q=>q.y0)),x1:Math.max(...rects.map(q=>q.x1)),y1:Math.max(...rects.map(q=>q.y1))}};
  const E=B.E, c0=approachCands(L,r,E,dyn).find(c=>c.ok); if(!c0){ exitCache[key]=null; return null; }
  // The car stays on the driveway: inside the area swept on the way in, or in a turning space near the carport.
  const MS=0.25, MI=Math.ceil(H.plot.w/MS)+1, MJ=Math.ceil((H.plot.d-Y0)/MS)+1, mask=new Uint8Array(MI*MJ), TY=12;
  for(let jj=0;jj<MJ;jj++) for(let ii=0;ii<MI;ii++){ const x=ii*MS, y=Y0+jj*MS; if(y<0||y>=H.house.y+H.house.d||(x>r.x-TY&&x<r.x+r.w+TY&&y>r.y-TY&&y<r.y+r.d+TY)) mask[jj*MI+ii]=1; }
  for(const q of acc.bays) if(q.ok) for(const p of q.poses){ const c=carCorners(p.x,p.y,p.a), xs=[c[0],c[2],c[4],c[6]], ys=[c[1],c[3],c[5],c[7]];
    for(let ii=Math.max(0,Math.floor(Math.min(...xs)/MS));ii<=Math.min(MI-1,Math.ceil(Math.max(...xs)/MS));ii++) for(let jj=Math.max(0,Math.floor((Math.min(...ys)-Y0)/MS));jj<=Math.min(MJ-1,Math.ceil((Math.max(...ys)-Y0)/MS));jj++){
      const px=ii*MS, py=Y0+jj*MS, s=Math.sin(p.a), co=Math.cos(p.a), u=(px-p.x)*s+(py-p.y)*co, v=(px-p.x)*co-(py-p.y)*s;
      if(u>=-VEH.ro-0.3&&u<=NOSE+0.3&&Math.abs(v)<=VEH.w/2+0.3) mask[jj*MI+ii]=1; } }
  const onDrive=(x,y,a)=>{ const c=carCorners(x,y,a); for(let k=0;k<8;k+=2){ const ii=Math.round(c[k]/MS), jj=Math.round((c[k+1]-Y0)/MS); if(ii<0||ii>=MI||jj<0||jj>=MJ||!mask[jj*MI+ii]) return false; } return true; };
  const edgeDrive=(x,y,P)=>{ for(const q of P.samples) if(!onDrive(x+q.x,y+q.y,q.a)) return false; return true; };
  const ex=acc.exit, okX=x=>x-VEH.w/2-VEH.clr>=ex.x0-EPS&&x+VEH.w/2+VEH.clr<=ex.x1+EPS;
  const {NI,NJ,N}=L, dist=new Float32Array(2*N).fill(Infinity), par=new Int32Array(2*N).fill(-1), pm=new Int8Array(2*N).fill(-1), done=new Uint8Array(2*N);
  const yOf=s=>Y0+(((s%N)>>3)/NI|0)*GS, hf=S=>Math.max(0,yOf(S)+1), heap=new Heap();
  dist[c0.s]=c0.k*GS*RVC; heap.push(dist[c0.s]+hf(c0.s),c0.s); let goal=-1, pops=0;
  const relax=(T,nd,from,m)=>{ if(nd<dist[T]-1e-9){ dist[T]=nd; par[T]=from; pm[T]=m; heap.push(nd+hf(T),T); } };
  while(heap.size){ const S=heap.pop(); if(done[S]) continue; done[S]=1; if(++pops>8000) break;
    const ph=S>=N?1:0, s=S%N, h=s&7, k=s>>3, i=k%NI, j=(k/NI)|0, x=i*GS, y=Y0+j*GS;
    if(y<=-1+1e-9&&okX(x)&&((ph===1&&h===4)||(ph===0&&h===0))){ goal=S; break; }
    if(ph===0){
      for(const [hp,p] of REV[h]){ const P=PRIMS[hp][p], pi=i-P.di, pj=j-P.dj; if(pi<0||pi>=NI||pj<0||pj>=NJ) continue; const py=Y0+pj*GS;
        if((y<0||py<0)&&!(P.dh===0&&h===0)) continue;
        const sp=(pj*NI+pi)*8+hp; if(done[sp]||!nodeOk(L,sp,dyn)||!edgeOk(L,sp,p,pi*GS,py,P,dyn)||!onDrive(pi*GS,py,HEADA(hp))||!edgeDrive(pi*GS,py,P)) continue;
        relax(sp,dist[S]+P.len*RVC+(P.dh?TURNPEN:0),S,p); }
      if(y>=0) relax(S+N,dist[S]+GEAR,S,3);
    } else {
      for(let p=0;p<3;p++){ const P=PRIMS[h][p]; if(y<0&&!(P.dh===0&&h===4)) continue;
        const ni=i+P.di, nj=j+P.dj; if(ni<0||ni>=NI||nj<0||nj>=NJ) continue; const nh=(h+P.dh+8)&7; if(Y0+nj*GS<0&&nh!==4) continue;
        const ns=(nj*NI+ni)*8+nh; if(done[ns+N]||!edgeOk(L,s,p,x,y,P,dyn)||!edgeDrive(x,y,P)) continue;
        relax(ns+N,dist[S]+P.cost,S,p); }
      if(y>=0) relax(S-N,dist[S]+GEAR,S,3); } }
  if(goal<0){ exitCache[key]=null; return null; }
  const chain=[]; for(let S=goal;S!==c0.s;S=par[S]) chain.push(S); chain.reverse();
  const pose=s=>{ const [x,y]=stXY(L,s%N); return {x,y,a:HEADA((s%N)&7)}; };
  const poses=lineFrom(E,c0.k).reverse().concat([pose(c0.s)]); let revTurns=0, fwd=false, fwdTurns=0, prev=c0.s, changes=0;
  for(const S of chain){ const m=pm[S];
    if(m===3){ fwd=S>=N; changes++; }
    else if(S<N){ const P=PRIMS[S&7][m], [x,y]=stXY(L,S); const seg=[{x,y,a:HEADA(S&7)},...P.samples.map(q=>({x:x+q.x,y:y+q.y,a:q.a}))].reverse(); seg.shift(); poses.push(...seg); if(P.dh) revTurns++; }
    else { const s=prev%N, P=PRIMS[s&7][m], [x,y]=stXY(L,s); poses.push(...P.samples.map(q=>({x:x+q.x,y:y+q.y,a:q.a}))); if(P.dh) fwdTurns++; }
    prev=S; }
  const txt=changes>=3?`makes a ${changes===3?"three":"multi"}-point turn, then drives forward to the road`:!fwd?(revTurns?"reverses out with a turn onto the road":"reverses straight back onto the road (no room to turn)"):(revTurns?"reverses out with a turn, then drives forward to the road":"reverses out, then drives forward to the road");
  return exitCache[key]={poses,txt,forward:fwd};
}
