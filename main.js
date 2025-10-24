'use strict';

const { Plugin, ItemView, Notice } = require('obsidian');
const VIEW_TYPE_ROADMAP = 'roadmap-view';

function elNS(name) { return document.createElementNS("http://www.w3.org/2000/svg", name); }
function createSVG(w, h) {
  const svg = elNS("svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.setAttribute("class", "roadmap-svg roadmap-pannable");

  const defs = elNS("defs");
  const marker = elNS("marker");
  marker.setAttribute("id", "arrowhead");
  marker.setAttribute("markerWidth", "10");
  marker.setAttribute("markerHeight", "7");
  marker.setAttribute("refX", "10");
  marker.setAttribute("refY", "3.5");
  marker.setAttribute("orient", "auto");
  const path = elNS("path");
  path.setAttribute("d", "M0,0 L10,3.5 L0,7 z");
  path.setAttribute("fill", "var(--text-faint)");
  marker.appendChild(path);
  defs.appendChild(marker);
  svg.appendChild(defs);
  return svg;
}
function shortenEdge(x1, y1, x2, y2, r) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx*dx + dy*dy) || 1;
  const ux = dx/len, uy = dy/len;
  return [x1+ux*r, y1+uy*r, x2-ux*r, y2-uy*r];
}

function normalizeRef(s) {
  if (!s) return "";
  return String(s).trim()
    .replace(/^\[\[/, "").replace(/\]\]$/, "")
    .replace(/\.(md|markdown)$/i, "");
}
function parseIncoming(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(normalizeRef).filter(Boolean);
  if (typeof value === "string")
    return value.split(/[,\|;]+/).map(normalizeRef).filter(Boolean);
  return [];
}
function parseYamlLoose(yaml) {
  const o = {};
  yaml.split("\n").forEach(l => {
    const m = /^([\w-]+):\s*(.*)$/.exec(l.trim());
    if (m) o[m[1]] = m[2];
  });
  return o;
}
function toYamlBlock(o) {
  return Object.entries(o).map(([k,v]) =>
    `${k}: ${Array.isArray(v)?v.join(", "):v}`).join("\n") + "\n";
}
function upsertFrontmatter(content, patch) {
  const fm = /^---\n([\s\S]*?)\n---\n?/;
  if (!fm.test(content))
    return `---\n${toYamlBlock(patch)}---\n${content}`;
  return content.replace(fm, (_, y) => {
    const o = parseYamlLoose(y); Object.assign(o, patch);
    return `---\n${toYamlBlock(o)}---\n`;
  });
}

function buildLevels(nodes) {
  const byBase = new Map(nodes.map(n=>[n.basename,n]));
  const resolve = ref => {
    if (byBase.has(ref)) return ref;
    const found = nodes.find(n=>n.title===ref||n.basename===ref||n.label===ref);
    return found?found.basename:null;
  };
  const adj = new Map(), indeg = new Map();
  nodes.forEach(n=>{adj.set(n.basename,[]); indeg.set(n.basename,0);});
  nodes.forEach(t=>{
    (t.incoming||[]).forEach(r=>{
      const s=resolve(r); if(!s||!adj.has(s))return;
      adj.get(s).push(t.basename);
      indeg.set(t.basename,(indeg.get(t.basename)||0)+1);
    });
  });
  const lvl=new Map(), q=[];
  nodes.forEach(n=>{
    if((indeg.get(n.basename)||0)===0){lvl.set(n.basename,1);q.push(n.basename);}
  });
  while(q.length){
    const u=q.shift(), lu=lvl.get(u)||1;
    (adj.get(u)||[]).forEach(v=>{
      if(!lvl.has(v)||lvl.get(v)<lu+1)lvl.set(v,lu+1);
      indeg.set(v,(indeg.get(v)||0)-1);
      if(indeg.get(v)===0)q.push(v);
    });
  }
  let max=1;
  nodes.forEach(n=>{
    if(!lvl.has(n.basename)){
      const ps=(n.incoming||[]).map(resolve).filter(Boolean)
        .map(b=>lvl.get(b)).filter(l=>l!==undefined);
      lvl.set(n.basename, ps.length?Math.max(...ps)+1:1);
    }
    max=Math.max(max,lvl.get(n.basename));
  });
  const groups=Array.from({length:max+1},()=>[]);
  nodes.forEach(n=>groups[lvl.get(n.basename)].push(n.basename));
  groups.forEach(g=>g.sort((a,b)=>a.localeCompare(b)));
  return {lvl,groups,max};
}

class RoadmapView extends ItemView {
  constructor(leaf,app){super(leaf);this.app=app;
    this.zoom=1;this.tx=0;this.ty=0;
    this.editMode=false;this.linkSource=null;
    this.tooltipEl=null; this._vp=null;
  }
  getViewType(){return VIEW_TYPE_ROADMAP;}
  getDisplayText(){return "Roadmap";}

  async onOpen(){
    const root=this.containerEl; root.empty(); root.addClass("roadmap-root");

   
    const header=root.createEl("div",{cls:"roadmap-header"});
    header.createEl("div",{text:"Roadmap — in work"});
    const btnEdit=header.createEl("button",{cls:"btn",text:"Edit links"});
    btnEdit.onclick=()=>{
      this.editMode=!this.editMode; this.linkSource=null;
      btnEdit.classList.toggle("active",this.editMode);
      this.render();
      new Notice(this.editMode
  ? "Edit mode: click a source, then a target (click again to remove the link). You can also click an arrow to delete it."
  : "Link editing is disabled.");

    };
    const btnReset=header.createEl("button",{cls:"btn",text:"Reset view"});
    btnReset.onclick=()=>{this.zoom=1;this.tx=0;this.ty=0;this._applyTransform();};

    this.canvas=root.createEl("div",{cls:"roadmap-canvas"});
    this.tooltipEl=root.createEl("div",{cls:"roadmap-tooltip"});
    this.hideTooltip();

    await this.render();
  }

  onClose(){
    this.canvas = null;
    this.tooltipEl = null;
  }

  showTooltip(text, x, y){
    if(!this.tooltipEl) return;
    this.tooltipEl.textContent = text;
    const bounds = this.canvas.getBoundingClientRect();
    const px = Math.max(8, Math.min(x - bounds.left, bounds.width - 8));
    const py = Math.max(8, Math.min(y - bounds.top + 16, bounds.height - 8));
    this.tooltipEl.style.left = `${px}px`;
    this.tooltipEl.style.top  = `${py}px`;
    this.tooltipEl.classList.add('is-visible');
  }
  moveTooltip(x, y){
    if(!this.tooltipEl || !this.tooltipEl.classList.contains('is-visible')) return;
    const bounds = this.canvas.getBoundingClientRect();
    const px = Math.max(8, Math.min(x - bounds.left, bounds.width - 8));
    const py = Math.max(8, Math.min(y - bounds.top + 16, bounds.height - 8));
    this.tooltipEl.style.left = `${px}px`;
    this.tooltipEl.style.top  = `${py}px`;
  }
  hideTooltip(){
    if(this.tooltipEl){
      this.tooltipEl.classList.remove('is-visible');
      this.tooltipEl.textContent = "";
    }
  }


  collectNodes(){
    const out=[];for(const f of this.app.vault.getMarkdownFiles()){
      const fm=this.app.metadataCache.getFileCache(f)?.frontmatter;
      if(!fm||fm.roadmap!==true)continue;

      const title = String(fm.title ?? f.basename);
      const label = String(fm.label ?? fm.title ?? f.basename);
      const description = fm.description ? String(fm.description) : "";
      const color = fm.color ? String(fm.color) : null;
      const status = (String(fm.status ?? "")).toLowerCase();
      const incoming = parseIncoming(fm.incoming ?? fm.from);

      out.push({ file:f, basename:f.basename, title, label, description, color, status, incoming });
    }return out;
  }

  async writeIncomingToFile(targetFile, incomingList) {
    const data = await this.app.vault.read(targetFile);
    const updated = upsertFrontmatter(data, {
      roadmap: true,
      status: "in-progress",
      incoming: (incomingList || []).join(", ")
    });
    await this.app.vault.modify(targetFile, updated);
  }


  _applyTransform(){
    if(this._vp)this._vp.setAttribute("transform",`translate(${this.tx},${this.ty}) scale(${this.zoom})`);
  }
  _attachPanZoom(svg){
    const vp=this._vp, min=0.2,max=5;
    svg.addEventListener("wheel",e=>{
      e.preventDefault();
      const r=svg.getBoundingClientRect();
      const Sx=e.clientX-r.left, Sy=e.clientY-r.top;
      const k=Math.exp(-e.deltaY*0.0015);
      const nz=Math.max(min,Math.min(max,this.zoom*k));
      this.tx=Sx-(nz/this.zoom)*(Sx-this.tx);
      this.ty=Sy-(nz/this.zoom)*(Sy-this.ty);
      this.zoom=nz; this._applyTransform();
    },{passive:false});
    let pan=false,lx=0,ly=0;
    svg.addEventListener("mousedown",e=>{
      if(e.button!==0||e.target.tagName!=='svg')return;
      pan=true;lx=e.clientX;ly=e.clientY;svg.classList.add("is-panning");
    });
    window.addEventListener("mousemove",e=>{
      if(!pan)return;
      const dx=e.clientX-lx,dy=e.clientY-ly;lx=e.clientX;ly=e.clientY;
      this.tx+=dx;this.ty+=dy;this._applyTransform();
    });
    window.addEventListener("mouseup",()=>{pan=false;svg.classList.remove("is-panning");});
  }


  async render(){
    if(!this.canvas) return;
    this.canvas.empty();
    this.hideTooltip();

    const nodes=this.collectNodes().filter(n=>n.status==="in-progress");
    const width=this.canvas.clientWidth||900, height=this.canvas.clientHeight||600;
    const R=60, vPad=40, hPad=40;

    const {groups,max}=buildLevels(nodes);
    const rowH=R*2+vPad, svgH=Math.max(height,max*rowH+vPad);
    const svg=createSVG(width,svgH); this.canvas.appendChild(svg);

    const vp=elNS("g"); svg.appendChild(vp); this._vp=vp;
    const edges=elNS("g"); edges.setAttribute("class","roadmap-edges"); vp.appendChild(edges);

    // positions
    const pos=new Map();
    const baseBottom=svgH-vPad-R;
    for(let L=1;L<=max;L++){
      const g=groups[L]||[], n=g.length||1, usable=width-hPad*2;
      g.forEach((b,i)=>{
        pos.set(b,{cx:hPad+((i+1)*usable)/(n+1), cy:baseBottom-(L-1)*rowH});
      });
    }

   
    nodes.forEach(t=>{
      const tp=pos.get(t.basename); if(!tp) return;
      (t.incoming||[]).forEach(r=>{
        const s=nodes.find(n=>n.basename===r||n.title===r||n.label===r);
        if(!s) return; const sp=pos.get(s.basename); if(!sp) return;
        const [x1,y1,x2,y2]=shortenEdge(sp.cx,sp.cy,tp.cx,tp.cy,R);
        const line=elNS("line");
        line.setAttribute("x1",x1); line.setAttribute("y1",y1);
        line.setAttribute("x2",x2); line.setAttribute("y2",y2);
        line.dataset.src=s.basename; line.dataset.dst=t.basename;

        if (this.editMode) {
          line.style.cursor = "pointer";
          line.addEventListener("click", async (e) => {
            e.stopPropagation();
            // удаляем ребро s -> t
            const target = nodes.find(n => n.basename === line.dataset.dst);
            if (!target) return;
            const newIncoming = (target.incoming || []).filter(x => x !== line.dataset.src);
            await this.writeIncomingToFile(target.file, newIncoming);
            new Notice(`Link was deleted: ${line.dataset.src} → ${line.dataset.dst}`);
            await this.render();
          });
        }

        edges.appendChild(line);
      });
    });

 
    const byBase=new Map(nodes.map(n=>[n.basename,n]));
    nodes.forEach(n=>{
      const p=pos.get(n.basename); if(!p) return;
      const {cx,cy}=p;

      const g=elNS("g"); vp.appendChild(g);

      const circle=elNS("circle");
      circle.setAttribute("cx",cx); circle.setAttribute("cy",cy); circle.setAttribute("r",R);
      let cls="roadmap-node"+(this.editMode&&this.linkSource===n.basename?" roadmap-node--selected":"");
      circle.setAttribute("class",cls);
      circle.style.transformBox="fill-box"; circle.style.transformOrigin="center";
      if(n.color){ circle.setAttribute("fill",n.color); circle.setAttribute("fill-opacity","0.25"); }
      g.appendChild(circle);

      const label=elNS("text");
      label.setAttribute("x",cx); label.setAttribute("y",cy);
      label.setAttribute("text-anchor","middle");
      label.setAttribute("dominant-baseline","middle");
      label.setAttribute("class","roadmap-label");
      label.textContent=n.label;
      g.appendChild(label);


      let ring=null;

    
      g.addEventListener("mouseenter",(e)=>{
        svg.classList.add("edge-dim");
        svg.querySelectorAll('line').forEach(l=>{
          if(l.dataset.src===n.basename || l.dataset.dst===n.basename) l.classList.add('edge-highlight');
        });
        vp.querySelectorAll('g').forEach(gg=>{ if(gg!==g) gg.classList.add('node-muted'); });
        g.classList.add('node-strong','node-hover');

        if(!ring){
          ring=elNS("circle");
          ring.setAttribute("cx",cx); ring.setAttribute("cy",cy); ring.setAttribute("r",R);
          ring.setAttribute("class","pulse-ring");
          g.appendChild(ring);
        }
        if (n.description) this.showTooltip(n.description, e.clientX, e.clientY);
      });
      g.addEventListener("mousemove",(e)=>{
        if (n.description) this.moveTooltip(e.clientX, e.clientY);
      });
      g.addEventListener("mouseleave",()=>{
        svg.classList.remove("edge-dim");
        svg.querySelectorAll('line.edge-highlight').forEach(l=>l.classList.remove('edge-highlight'));
        vp.querySelectorAll('.node-muted').forEach(gg=>gg.classList.remove('node-muted'));
        g.classList.remove('node-strong','node-hover');
        if(ring){ ring.remove(); ring=null; }
        this.hideTooltip();
      });


      g.addEventListener("click", async (e)=>{
        e.stopPropagation();
        if(!this.editMode){
          const leaf=this.app.workspace.getLeaf(true);
          await leaf.openFile(n.file); return;
        }
        if(!this.linkSource){
  
          this.linkSource=n.basename; this.render(); new Notice("Source: "+n.title);
        } else if (this.linkSource===n.basename){
 
          this.linkSource=null; this.render();
        } else {

          const src=this.linkSource, target=byBase.get(n.basename);
          if(!target) return;
          const cur = target.incoming || [];
          const exists = cur.includes(src);
          const next = exists ? cur.filter(x=>x!==src) : [...cur, src];
          await this.writeIncomingToFile(target.file, next);
          new Notice((exists ? "Deleted" : "Added") + ` link: ${src} → ${target.basename}`);
          this.linkSource=null; await this.render();
        }
      });

      g.style.cursor="pointer";
    });


    this._applyTransform();
    this._attachPanZoom(svg);
  }
}


module.exports = class RoadmapPlugin extends Plugin {
  async onload(){
    this.addCommand({
      id:"open-roadmap",
      name:"Open Roadmap",
      callback:async()=>{
        const leaf=this.app.workspace.getLeaf(true);
        await leaf.setViewState({type:VIEW_TYPE_ROADMAP,active:true});
        this.app.workspace.revealLeaf(leaf);
      }
    });
    this.addCommand({
      id:"mark-in-progress",
      name: "Mark current note as in-progress",
      checkCallback:(c)=>{
        const f=this.app.workspace.getActiveFile(); if(!f) return false;
        if(!c) this.mark(f); return true;
      }
    });
    this.registerView(VIEW_TYPE_ROADMAP,leaf=>new RoadmapView(leaf,this.app));
    const ref=()=>this.app.workspace.getLeavesOfType(VIEW_TYPE_ROADMAP).forEach(l=>l.view?.render());
    this.registerEvent(this.app.metadataCache.on("changed",ref));
    this.registerEvent(this.app.vault.on("rename",ref));
    this.registerEvent(this.app.vault.on("delete",ref));
    this.registerEvent(this.app.vault.on("create",ref));
  }

async mark(file) {

  const data = await this.app.vault.read(file);

  const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter) || {};

  const patch = {
    roadmap: true,
    status: "in-progress",

    title: (typeof fm.title === "string" && fm.title.trim().length) ? fm.title : file.basename,
    label: (typeof fm.label === "string" && fm.label.trim().length)
      ? fm.label
      : ((typeof fm.title === "string" && fm.title.trim().length) ? fm.title : file.basename),


    description: (typeof fm.description === "string") ? fm.description : "",

    color: (typeof fm.color === "string") ? fm.color : "",
    incoming: (fm.incoming ?? fm.from ?? "")
  };

  const updated = upsertFrontmatter(data, patch);
  await this.app.vault.modify(file, updated);

  new Notice("Marked as in-progress. Added/updated: title, label, description, color, incoming.");
}

};
