'use strict';

const { Plugin, ItemView, Notice, SuggestModal, Modal } = require('obsidian');

const VIEW_TYPE_ROADMAP = 'roadmap-view';

const MODE_NONE = 0;
const MODE_ADD  = 1;
const MODE_REMOVE = 2;


function elNS(name) { return document.createElementNS("http://www.w3.org/2000/svg", name); }
function createSVG(w, h) {
  const svg = elNS("svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.setAttribute("class", "roadmap-svg roadmap-pannable");

  // defs: arrowhead
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
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  return [ x1 + ux * r, y1 + uy * r, x2 - ux * r, y2 - uy * r ];
}


function rngFromSeed(seed) {
  let s = (Number(seed) >>> 0) || 1;
  return function() {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function randomInt(rng, n){ return Math.floor(rng()*n); }


function normalizeRef(s) {
  if (!s) return "";
  return String(s).trim()
    .replace(/^\[\[/, "").replace(/\]\]$/, "")
    .replace(/\.(md|markdown)$/i, "");
}
function parseListish(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(normalizeRef).filter(Boolean);
  if (typeof value === "string") return value.split(/[,\|;]+/).map(normalizeRef).filter(Boolean);
  return [];
}
function parseIncoming(v){ return parseListish(v); }
function parseRoadmapRefs(v){ return parseListish(v); }

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


function refEqualsIncoming(incomingItem, node) {
  const inc = normalizeRef(incomingItem);
  return inc === node.basename
      || inc === (node.title ?? "")
      || inc === (node.label ?? "")
      || inc === normalizeRef(node.title ?? "")
      || inc === normalizeRef(node.label ?? "");
}


function buildLevels(nodes) {
  const byBase = new Map(nodes.map(n=>[n.basename,n]));
  const resolve = ref => {
    const clean = normalizeRef(ref);
    if (byBase.has(clean)) return clean;
    const found = nodes.find(n => n.basename===clean || n.title===clean || n.label===clean);
    return found ? found.basename : null;
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
  return {lvl,groups,max};
}


function collectConfigs(app){
  const out=[];
  for (const f of app.vault.getMarkdownFiles()){
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    if (!fm) continue;
    const isCfg = fm.roadmap_config === true || fm['roadmap-config'] === true;
    if (!isCfg) continue;

    const name = String(fm.name ?? fm.title ?? f.basename);
    const allowedStatuses = parseListish(fm.statuses ?? fm.allowed_statuses ?? fm.allowedStatuses);
    const defaultNodeRadius = Number(fm.node_radius ?? fm.nodeRadius ?? 60) || 60;
    const defaultLayerGap   = Number(fm.layer_gap ?? fm.layerGap ?? 40) || 40;
    const seedRaw = fm.seed ?? fm.layout_seed ?? fm.layoutSeed;
    const seed = Number(seedRaw) >>> 0;

    out.push({
      file: f,
      basename: f.basename,
      title: name,
      allowedStatuses,
      defaultNodeRadius,
      defaultLayerGap,
      seed: seed || 0
    });
  }
  out.sort((a,b)=>a.title.localeCompare(b.title));
  return out;
}

function nodeBelongsToConfig(nodeFm, cfgBasename){
  const refs = parseRoadmapRefs(nodeFm?.roadmap);
  if (refs.length === 0) return false;
  return refs.map(normalizeRef).includes(normalizeRef(cfgBasename));
}


class RoadmapPicker extends SuggestModal {
  constructor(app, configs, onChoose){ super(app); this.configs = configs; this.onChoose = onChoose; }
  getSuggestions(query){
    const q = query.toLowerCase().trim();
    const list = this.configs.map(c=>({label:c.title, sub:`${c.basename} (seed: ${c.seed||'—'})`, item:c}));
    if (!q) return list;
    return list.filter(x => x.label.toLowerCase().includes(q) || x.sub.toLowerCase().includes(q));
  }
  renderSuggestion(v, el){
    el.createEl('div', { text: v.label });
    el.createEl('small', { text: v.sub, cls: 'u-muted' });
  }
  onChooseSuggestion(v){
    this.onChoose(v.item);
  }
}

class PromptModal extends Modal {
  constructor(app, opts){ super(app); this.opts = opts || {}; }
  onOpen(){
    const { title="Create new roadmap", placeholder="New Roadmap", initial="" } = this.opts;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: title });

    const wrap = contentEl.createEl('div');
    wrap.style.display = 'flex';
    wrap.style.gap = '8px';

    const input = wrap.createEl('input', { type: 'text' });
    input.placeholder = placeholder;
    input.value = initial;

    const btn = wrap.createEl('button', { text: 'Create' });

    const submit = ()=>{
      const val = input.value.trim() || placeholder;
      this.close();
      this.opts.onSubmit?.(val);
    };

    btn.onclick = submit;
    input.addEventListener('keydown', (e)=>{
      if (e.key === 'Enter') submit();
    });
    setTimeout(()=> input.focus(), 30);
  }
  onClose(){ this.contentEl.empty(); }
}


class RoadmapView extends ItemView {
  constructor(leaf,app,plugin){super(leaf);this.app=app;this.plugin=plugin;
    this.zoom=1;this.tx=0;this.ty=0;

    this.mode = MODE_NONE;
    this.linkSource=null;

    this.nodeRadius = 60;
    this.layerGap   = 40;

    this.currentConfig = null;   // {basename, seed, ...}
    this.tooltipEl=null; this._vp=null;
    this.headerTitleEl=null;
  }

  getViewType(){return VIEW_TYPE_ROADMAP;}
  getDisplayText(){return "Roadmap (Graph)";}

  async onOpen(){
    const root=this.containerEl; root.empty(); root.addClass("roadmap-root");

  
    const header=root.createEl("div",{cls:"roadmap-header"});
    this.headerTitleEl = header.createEl("div",{text:"Roadmap graph"});

    const btnChoose=header.createEl("button",{cls:"btn",text:"Switch roadmap"});
    const btnShuffle=header.createEl("button",{cls:"btn",text:"Shuffle"});
    const btnAdd=header.createEl("button",{cls:"btn",text:"Add link"});
    const btnRemove=header.createEl("button",{cls:"btn",text:"Remove link"});
    const btnReset=header.createEl("button",{cls:"btn",text:"Reset view"});

  
    const wrapControls = header.createEl("div", {cls:"controls"});
    wrapControls.style.display = "flex";
    wrapControls.style.gap = "8px";
    wrapControls.style.alignItems = "center";
    wrapControls.style.marginLeft = "8px";

    const mkRange = (labelText, min, max, step, value, onInput) => {
      const box = document.createElement("label");
      box.style.display = "flex";
      box.style.alignItems = "center";
      box.style.gap = "6px";
      const span = document.createElement("span");
      span.textContent = labelText;
      span.style.fontSize = "12px";
      const out = document.createElement("span");
      out.textContent = String(value);
      out.style.fontSize = "12px";
      out.style.opacity = "0.8";
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(value);
      input.oninput = () => {
        const v = Number(input.value);
        out.textContent = String(v);
        onInput(v);
      };
      box.appendChild(span); box.appendChild(input); box.appendChild(out);
      return box;
    };

    const rNode = mkRange("Node size", 30, 120, 2, this.nodeRadius, (v)=>{
      this.nodeRadius = v; this.render();
    });
    const rGap = mkRange("Layer spacing", 20, 200, 2, this.layerGap, (v)=>{
      this.layerGap = v; this.render();
    });
    wrapControls.appendChild(rNode);
    wrapControls.appendChild(rGap);

    const openPicker = async ()=>{
      const configs = collectConfigs(this.app);
      if (configs.length===0){ new Notice("No roadmap configs found. Create a note with frontmatter: 'roadmap_config: true'"); return; }
      const picker = new RoadmapPicker(this.app, configs, async (cfg)=>{
        this.currentConfig = cfg;
        if (!cfg.seed) {
          await this.updateConfigSeed(cfg, (Date.now()>>>0));
          cfg.seed = this.currentConfig.seed;
          new Notice(`Seed initialized for "${cfg.title}": ${cfg.seed}`);
        }
        this.nodeRadius = cfg.defaultNodeRadius ?? 60;
        this.layerGap   = cfg.defaultLayerGap   ?? 40;
        await this.plugin.saveState({ currentConfigBasename: cfg.basename });
        this.render();
      });
      picker.open();
    };

    btnChoose.onclick = openPicker;

    btnShuffle.onclick = async ()=>{
      if (!this.currentConfig){ new Notice("Select a roadmap config first."); return; }
      const newSeed = (Math.random()*0xFFFFFFFF)>>>0;
      await this.updateConfigSeed(this.currentConfig, newSeed);
      new Notice(`New seed: ${newSeed}`);
      await this.render();
    };

    const setMode = (m)=>{
      this.mode = (this.mode===m) ? MODE_NONE : m;
      this.linkSource = null;
      btnAdd.classList.toggle("active", this.mode===MODE_ADD);
      btnRemove.classList.toggle("active", this.mode===MODE_REMOVE);
      this.render();
      if (this.mode===MODE_ADD) new Notice("Add mode: click a source, then a target to create a link.");
      else if (this.mode===MODE_REMOVE) new Notice("Remove mode: click a source, then a target to remove a link. You can also click an arrow.");
      else new Notice("Editing disabled.");
    };

    btnAdd.onclick = ()=> setMode(MODE_ADD);
    btnRemove.onclick = ()=> setMode(MODE_REMOVE);
    btnReset.onclick = ()=>{
      this.zoom=1; this.tx=0; this.ty=0; this.render();
    };

    // canvas & tooltip
    this.canvas=root.createEl("div",{cls:"roadmap-canvas"});
    this.tooltipEl=root.createEl("div",{cls:"roadmap-tooltip"});
    this.hideTooltip();

    const saved = await this.plugin.loadState();
    if (saved?.currentConfigBasename){
      const cfgs = collectConfigs(this.app);
      const m = cfgs.find(c=>c.basename===saved.currentConfigBasename);
      if (m){
        this.currentConfig = m;
        if (!m.seed) { await this.updateConfigSeed(m, (Date.now()>>>0)); }
        this.nodeRadius=m.defaultNodeRadius;
        this.layerGap=m.defaultLayerGap;
      }
    }
    if (!this.currentConfig) openPicker();

    await this.render();
  }

  async updateConfigSeed(cfg, newSeed){
    const data = await this.app.vault.read(cfg.file);
    const updated = upsertFrontmatter(data, { seed: Number(newSeed) >>> 0 });
    await this.app.vault.modify(cfg.file, updated);
    cfg.seed = Number(newSeed) >>> 0;
    this.currentConfig = cfg;
  }

  onClose(){ this.canvas=null; this.tooltipEl=null; }

  /* ------- tooltips ------- */
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

  /* ------- data ------- */
  collectNodes(){
    if (!this.currentConfig) return [];
    const cfg = this.currentConfig;
    const allowed = cfg.allowedStatuses?.length ? cfg.allowedStatuses.map(s=>String(s).toLowerCase()) : ["in-progress"];

    const out=[];
    for(const f of this.app.vault.getMarkdownFiles()){
      const fm=this.app.metadataCache.getFileCache(f)?.frontmatter;
      if(!fm) continue;

      if (!nodeBelongsToConfig(fm, cfg.basename)) continue;

      const title = String(fm.title ?? f.basename);
      const label = String(fm.label ?? fm.title ?? f.basename);
      const description = fm.description ? String(fm.description) : "";
      const color = (typeof fm.color === 'string') ? fm.color : null;
      const status = (String(fm.status ?? "")).toLowerCase();

      if (!allowed.includes(status)) continue;

      const incoming = parseIncoming(fm.incoming ?? fm.from);
      out.push({ file:f, basename:f.basename, title, label, description, color, status, incoming });
    }
    return out;
  }

  /* ------- file update helpers ------- */
  async writeIncomingToFile(targetFile, incomingList) {
    const data = await this.app.vault.read(targetFile);
    const updated = upsertFrontmatter(data, {
      incoming: (incomingList || []).join(", ")
    });
    await this.app.vault.modify(targetFile, updated);
  }

  /* ------- viewport ------- */
  _applyTransform(){
    if(this._vp)this._vp.setAttribute("transform",`translate(${this.tx},${this.ty}) scale(${this.zoom})`);
  }
  _attachPanZoom(svg){
    const min=0.2,max=5;
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

  _updateHeaderTitle(){
    if (!this.headerTitleEl) return;
    const cfg = this.currentConfig;
    const name = cfg ? cfg.title : "";
    const seedTxt = cfg ? ` (seed: ${cfg.seed || '—'})` : "";
    this.headerTitleEl.setText(`Roadmap graph${name ? ' • '+name : ''}${seedTxt}`);
  }

  async render(){
    if(!this.canvas) return;
    this.canvas.empty();
    this.hideTooltip();

    if (!this.currentConfig){
      const emptyMsg = this.canvas.createEl("div", { text: "Select a roadmap config (Switch roadmap)", cls: "u-muted" });
      emptyMsg.style.position = "absolute";
      emptyMsg.style.left = "16px";
      emptyMsg.style.top = "48px";
      this._updateHeaderTitle();
      return;
    }

    const nodes=this.collectNodes();
    const width=this.canvas.clientWidth||900, height=this.canvas.clientHeight||600;

    const R   = this.nodeRadius;
    const vPad= this.layerGap;
    const hPad= 40;

    const seed = this.currentConfig.seed || 1;
    const rng  = rngFromSeed(seed);

    const {groups,max}=buildLevels(nodes);
    const rowH=R*2+vPad, svgH=Math.max(height,max*rowH+vPad);
    const svg=createSVG(width,svgH); this.canvas.appendChild(svg);

    const vp=elNS("g"); svg.appendChild(vp); this._vp=vp;


    const edges=elNS("g"); edges.setAttribute("class","roadmap-edges"); vp.appendChild(edges);


    const pos=new Map();
    const baseBottom=svgH-vPad-R;
    for(let L=1;L<=max;L++){
      const g=groups[L]||[];
      const usable=width-hPad*2;
      const slots = Math.max(1, g.length);

      const shuffled = g.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = randomInt(rng, i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }

      shuffled.forEach((basename, idx) => {
        const cell = usable/(slots+1);
        const baseX = hPad + ((idx + 1) * usable) / (slots + 1);
        const jitter = (rng() - 0.5) * Math.min(cell/3, 60);
        const cx = Math.max(hPad+R, Math.min(width - hPad - R, baseX + jitter));
        const cy = Math.floor(baseBottom - (L - 1) * rowH);
        pos.set(basename, { cx, cy });
      });
    }


    nodes.forEach(t=>{
      const tp=pos.get(t.basename); if(!tp) return;
      (t.incoming||[]).forEach(r=>{
        const ref = normalizeRef(r);
        const s=nodes.find(n=> n.basename===ref || n.title===ref || n.label===ref || n.basename===r || n.title===r || n.label===r);
        if(!s) return; const sp=pos.get(s.basename); if(!sp) return;

        const [x1,y1,x2,y2] = shortenEdge(sp.cx, sp.cy, tp.cx, tp.cy, R);
        const line=elNS("line");
        line.setAttribute("x1",x1); line.setAttribute("y1",y1);
        line.setAttribute("x2",x2); line.setAttribute("y2",y2);
        line.dataset.src=s.basename; line.dataset.dst=t.basename;
        edges.appendChild(line);

        const hit = elNS("line");
        hit.setAttribute("x1",x1); hit.setAttribute("y1",y1);
        hit.setAttribute("x2",x2); hit.setAttribute("y2",y2);
        hit.setAttribute("stroke-width","12");
        hit.setAttribute("stroke","transparent");
        hit.style.pointerEvents = "stroke";
        if (this.mode === MODE_REMOVE) hit.style.cursor = "pointer";
        hit.dataset.src=s.basename; hit.dataset.dst=t.basename;

        if (this.mode === MODE_REMOVE) {
          hit.addEventListener("click", async (e) => {
            e.stopPropagation();
            const target = nodes.find(n => n.basename === hit.dataset.dst);
            const source = nodes.find(n => n.basename === hit.dataset.src);
            if (!target || !source) return;
            const next = (target.incoming || []).filter(item => !refEqualsIncoming(item, source));
            await this.writeIncomingToFile(target.file, next);
            new Notice(`Link removed: ${source.basename} → ${target.basename}`);
            await this.render();
          });
        }
        edges.appendChild(hit);
      });
    });

    
    const byBase=new Map(nodes.map(n=>[n.basename,n]));
    nodes.forEach(n=>{
      const p=pos.get(n.basename); if(!p) return;
      const {cx,cy}=p;

      const g=elNS("g"); vp.appendChild(g);

      const circle=elNS("circle");
      circle.setAttribute("cx",cx); circle.setAttribute("cy",cy); circle.setAttribute("r",R);
      circle.setAttribute("class","roadmap-node");
      if (n.color && typeof n.color === 'string') {
        circle.style.fill = n.color;
        circle.style.opacity = '1';
      } else {
        circle.style.fill = 'var(--interactive-accent)';
        circle.style.opacity = '0.25';
      }
      g.appendChild(circle);

      const label=elNS("text");
      label.setAttribute("x",cx); label.setAttribute("y",cy);
      label.setAttribute("text-anchor","middle");
      label.setAttribute("dominant-baseline","middle");
      label.setAttribute("class","roadmap-label");
      label.textContent=n.label;


      label.style.paintOrder = 'stroke';
      label.style.stroke = 'rgba(0,0,0,0.72)';   
      label.style.strokeWidth = '3px';         
      label.style.strokeLinejoin = 'round';
      label.style.strokeLinecap = 'round';



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
        if(this.mode === MODE_NONE){
          const leaf=this.app.workspace.getLeaf(true);
          await leaf.openFile(n.file); return;
        }

        if(!this.linkSource){
          this.linkSource=n.basename;
          new Notice((this.mode===MODE_ADD ? "Add" : "Remove") + " mode: source selected. Now click a target.");
        } else if (this.linkSource===n.basename) {
          this.linkSource=null;
        } else {
          const srcBase=this.linkSource, target=byBase.get(n.basename);
          this.linkSource=null;
          if (!target) return;

          const cur = target.incoming || [];
          if (this.mode === MODE_ADD) {
            if (!cur.some(item => refEqualsIncoming(item, byBase.get(srcBase)))) {
              const next = [...cur, srcBase];
              await this.writeIncomingToFile(target.file, next);
              new Notice(`Link added: ${srcBase} → ${target.basename}`);
            } else {
              new Notice(`Link already exists: ${srcBase} → ${target.basename}`);
            }
            await this.render();
          } else if (this.mode === MODE_REMOVE) {
            const sourceNode = byBase.get(srcBase);
            const next = cur.filter(item => !refEqualsIncoming(item, sourceNode));
            if (next.length === cur.length) {
              new Notice(`No such link to remove: ${srcBase} → ${target.basename}`);
            } else {
              await this.writeIncomingToFile(target.file, next);
              new Notice(`Link removed: ${srcBase} → ${target.basename}`);
            }
            await this.render();
          }
        }
      });

      g.style.cursor="pointer";
    });

    this._applyTransform();
    this._attachPanZoom(svg);


    this._updateHeaderTitle();
  }
}


module.exports = class RoadmapPlugin extends Plugin {
  async onload(){
    this.state = await this.loadData() || {};

    this.addCommand({
      id:"open-roadmap-graph",
      name:"Open Roadmap (graph)",
      callback:async()=>{
        const leaf=this.app.workspace.getLeaf(true);
        await leaf.setViewState({type:VIEW_TYPE_ROADMAP,active:true});
        this.app.workspace.revealLeaf(leaf);
      }
    });

    this.addCommand({
      id:"create-roadmap-config",
      name:"Create new roadmap",
      callback: async () => {
        await this.createRoadmapConfig();
      }
    });

    this.addCommand({
      id:"mark-in-progress",
      name:"Mark current note as in-progress",
      checkCallback:(checking)=>{
        const file=this.app.workspace.getActiveFile(); if(!file) return false;
        if (!checking) this.mark(file);
        return true;
      }
    });

    this.registerView(VIEW_TYPE_ROADMAP, leaf => new RoadmapView(leaf,this.app,this));

    const ref=()=>this.app.workspace.getLeavesOfType(VIEW_TYPE_ROADMAP).forEach(l=>l.view?.render());
    this.registerEvent(this.app.metadataCache.on("changed",ref));
    this.registerEvent(this.app.vault.on("rename",ref));
    this.registerEvent(this.app.vault.on("delete",ref));
    this.registerEvent(this.app.vault.on("create",ref));
  }

  async saveState(patch){
    Object.assign(this.state, patch||{});
    await this.saveData(this.state);
  }
  async loadState(){ return this.state; }

  async createRoadmapConfig(){
    const askName = () => new Promise((resolve)=>{
      const modal = new PromptModal(this.app, {
        title: "Create new roadmap",
        placeholder: "New Roadmap",
        onSubmit: (val)=> resolve(val)
      });
      modal.open();
    });

    const name = (await askName()) || "New Roadmap";
    const base = name.trim();
    let basename = base.replace(/[\\/:*?"<>|#^\[\]]+/g, " ").trim() || "New Roadmap";

    let filePath = `${basename}.md`;
    let i = 1;
    while (this.app.vault.getAbstractFileByPath(filePath)) {
      filePath = `${basename}-${i}.md`; i++;
    }

    const seed = (Math.random()*0xFFFFFFFF)>>>0;

    const fm = {
      roadmap_config: true,
      name: basename,
      statuses: ["in-progress"],
      node_radius: 60,
      layer_gap: 40,
      seed: seed
    };

    const body = `---\n${toYamlBlock(fm)}---\n# ${basename}\n\nThis note configures a Roadmap graph.\n\n- Add notes and set \`roadmap: ${basename}\` in their frontmatter.\n- Only notes with allowed \`status\` values are shown.\n- Current seed: \`${seed}\` (use the **Shuffle** button to randomize layout).\n`;

    const file = await this.app.vault.create(filePath, body);
    await this.saveState({ currentConfigBasename: file.basename });

    const leaf=this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
    new Notice(`Roadmap config created: ${file.basename} (seed: ${seed})`);
  }

  async mark(file){
    const data=await this.app.vault.read(file);
    const fm=this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const currentConfigBasename = this.state?.currentConfigBasename;

    const patch={
      roadmap: currentConfigBasename ? currentConfigBasename : (fm.roadmap ?? ""),
      status:"in-progress",
      title: (typeof fm.title==="string" && fm.title.trim().length) ? fm.title : file.basename,
      label: (typeof fm.label==="string" && fm.label.trim().length) ? fm.label :
             ((typeof fm.title==="string" && fm.title.trim().length) ? fm.title : file.basename),
      description: (typeof fm.description==="string") ? fm.description : "",
      color: (typeof fm.color==="string") ? fm.color : "",
      incoming: (fm.incoming ?? fm.from ?? "")
    };

    const updated = upsertFrontmatter(data, patch);
    await this.app.vault.modify(file, updated);

    if (!currentConfigBasename){
      new Notice("Marked as in-progress. Tip: select a roadmap config (Switch roadmap) to set 'roadmap:' automatically.");
    } else {
      new Notice(`Marked as in-progress and added to roadmap: ${currentConfigBasename}`);
    }
  }
};
