const state = { db:null, currentUser:null, currentImportId:null, importRows:[] };
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
function el(tag, attrs={}, children=[]) {
  const n=document.createElement(tag);
  for(const [k,v] of Object.entries(attrs)){ if(k==="class") n.className=v; else if(k==="html") n.innerHTML=v; else n.setAttribute(k,v); }
  (Array.isArray(children)?children:[children]).forEach(c=>{ if(c==null) return; if(typeof c==="string") n.appendChild(document.createTextNode(c)); else n.appendChild(c); });
  return n;
}
async function api(url, options={}) {
  const res = await fetch(url, options);
  const isJson=(res.headers.get("content-type")||"").includes("application/json");
  const data=isJson?await res.json():await res.text();
  if(!res.ok) throw new Error(data.message||"Errore richiesta");
  return data;
}
async function loadBootstrap(){ state.db=await api("/api/bootstrap"); }
function productName(id){ return state.db.products.find(x=>Number(x.id)===Number(id))?.name || "-"; }
function supplierName(id){ return state.db.suppliers.find(x=>Number(x.id)===Number(id))?.name || "-"; }
function clientName(id){ return state.db.clients.find(x=>Number(x.id)===Number(id))?.name || "-"; }
function warehouseName(id){ return state.db.warehouses.find(x=>Number(x.id)===Number(id))?.name || "-"; }
function partnerName(type,id){ return type==="supplier"?supplierName(id):clientName(id); }

function resetProductForm() {
  const form = $("#form-product");
  form.reset();
  form.querySelector('[name="id"]').value = "";
  $("#product-form-title").textContent = "Nuovo articolo principale";
  $("#product-save-btn").textContent = "Salva articolo";
  $("#product-cancel-edit").classList.add("hidden");
}

function fillProductForm(product) {
  const form = $("#form-product");
  form.querySelector('[name="id"]').value = product.id;
  form.querySelector('[name="name"]').value = product.name || "";
  form.querySelector('[name="sku"]').value = product.sku || "";
  form.querySelector('[name="category"]').value = product.category || "";
  form.querySelector('[name="color"]').value = product.color || "";
  form.querySelector('[name="size"]').value = product.size || "";
  form.querySelector('[name="notes"]').value = product.notes || "";
  form.querySelector('[name="purchasePriceNet"]').value = product.purchasePriceNet ?? "";
  form.querySelector('[name="purchasePriceGross"]').value = product.purchasePriceGross ?? "";
  form.querySelector('[name="salePriceNet"]').value = product.salePriceNet ?? "";
  form.querySelector('[name="salePriceGross"]').value = product.salePriceGross ?? "";
  form.querySelector('[name="vatRate"]').value = product.vatRate ?? "";
  $("#product-form-title").textContent = "Modifica articolo principale";
  $("#product-save-btn").textContent = "Salva modifica";
  $("#product-cancel-edit").classList.remove("hidden");
}

async function deleteProduct(product) {
  const stockRows = state.db.stocks.filter(s => Number(s.productId) === Number(product.id));
  const totalQty = stockRows.reduce((sum, s) => sum + Number(s.qty || 0), 0);

  let message = `Confermi l'eliminazione del prodotto "${product.name}"?`;
  if (totalQty > 0) {
    message =
      `ATTENZIONE: il prodotto "${product.name}" ha giacenze maggiori di zero (${totalQty}).\n\n` +
      `Confermi comunque l'eliminazione?`;
  }

  const confirmed = confirm(message);
  if (!confirmed) return;

  try {
    await api(`/api/products/${product.id}?force=1`, { method: "DELETE" });
    alert(`Operazione completata: prodotto "${product.name}" eliminato con successo.`);
    await loadBootstrap();
    renderProducts();
    renderStocks();
    renderDashboard();
    renderAliases();
    resetProductForm();
  } catch (err) {
    alert(err.message || "Errore eliminazione prodotto");
  }
}

function rolePermissions() {
  const roles = state.db.roles || [];
  const key = state.currentUser?.roleKey || "viewer";
  return roles.find(r => r.key === key)?.permissions || [];
}
function canView(section) {
  const perms = rolePermissions();
  return perms.includes("all") || perms.includes(section);
}
function applyPermissionsUI() {
  $$(".nav button").forEach(btn => {
    const view = btn.dataset.view;
    btn.classList.toggle("hidden", !canView(view));
  });
  if (state.currentUser) {
    $("#user-management-panel").classList.toggle("hidden", !canView("users"));
  }
}
function filterList(list,q,fields){ q=String(q||"").trim().toLowerCase(); if(!q) return list; return list.filter(x=>fields.some(f=>String(typeof f==="function"?f(x):x[f]||"").toLowerCase().includes(q))); }

function normalizeText(s){
  return String(s||"").toLowerCase()
    .replace(/[().,#\-_/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function extractSize(text){
  const t = normalizeText(text).replace(/\s/g, "");
  const m = t.match(/(\d{2,3})x(\d{2,3})/);
  return m ? `${m[1]}x${m[2]}` : "";
}
function guessProductIdSmart(row, direction, supplierId){
  const type = direction === "supplier" ? "supplier" : "sale";
  const code = String(row.supplierCode || "").trim().toLowerCase();
  const desc = normalizeText(row.description || "");
  const size = extractSize(row.description || "");

  const candidates = state.db.aliases.filter(a => {
    if (String(a.aliasType || "supplier") !== type) return false;
    if (type === "supplier" && Number(a.supplierId || 0) !== Number(supplierId || 0)) return false;
    return true;
  });

  if (code) {
    const exactCode = candidates.find(a => String(a.supplierCode || "").trim().toLowerCase() === code);
    if (exactCode) return exactCode.productId;
  }

  if (desc) {
    const exactDesc = candidates.find(a => normalizeText(a.supplierDescription || "") === desc);
    if (exactDesc) return exactDesc.productId;
  }

  if (desc) {
    const partialAlias = candidates.find(a => {
      const ad = normalizeText(a.supplierDescription || "");
      const aliasSize = extractSize(ad);
      const sameSize = !size || !aliasSize || aliasSize === size;
      return sameSize && ad && (ad.includes(desc) || desc.includes(ad));
    });
    if (partialAlias) return partialAlias.productId;
  }

  if (desc || size) {
    const partialProduct = state.db.products.find(p => {
      const pt = normalizeText(`${p.name || ""} ${p.sku || ""} ${p.category || ""} ${p.size || ""}`);
      const productSize = extractSize(`${p.name || ""} ${p.size || ""}`);
      const sameSize = !size || !productSize || productSize === size;
      return sameSize && pt && (pt.includes(desc) || desc.includes(pt) || (size && productSize === size));
    });
    if (partialProduct) return partialProduct.id;
  }

  return "";
}
function renderDashboard(){
  $("#kpi-products").textContent=state.db.products.length; $("#kpi-suppliers").textContent=state.db.suppliers.length; $("#kpi-warehouses").textContent=state.db.warehouses.length; $("#kpi-lowstock").textContent=(state.db.lowStock||[]).length;
  const stockBody=$("#dashboard-stock-body"); stockBody.innerHTML="";
  state.db.products.slice(0,8).forEach(p=>{ const total=state.db.stocks.filter(s=>Number(s.productId)===Number(p.id)).reduce((a,b)=>a+Number(b.qty),0); stockBody.appendChild(el("tr",{},[el("td",{},p.name),el("td",{},p.sku||""),el("td",{},p.category||""),el("td",{},String(total))])); });
  const low=$("#dashboard-lowstock"); low.innerHTML="";
  if(!(state.db.lowStock||[]).length) low.appendChild(el("div",{"class":"small"},"Nessun articolo sotto scorta."));
  else state.db.lowStock.forEach(s=>low.appendChild(el("div",{"class":"status-box"},`${productName(s.productId)} · ${warehouseName(s.warehouseId)} · disponibile ${s.qty} / minimo ${s.minQty}`)));
}
function renderGlobalSearchResults(results){
  const wrap=$("#global-search-results"); wrap.innerHTML=""; if(!results) return;
  const entries=[["Prodotti",results.products,x=>`${x.name} · ${x.sku||""}`],["Fornitori",results.suppliers,x=>`${x.name} · ${x.vat||""}`],["Clienti",results.clients,x=>`${x.name} · ${x.vat||""}`],["Magazzini",results.warehouses,x=>`${x.name} · ${x.city||""}`],["Giacenze",results.stocks,x=>`${productName(x.productId)} · ${warehouseName(x.warehouseId)} · qty ${x.qty}`],["Movimenti",results.movements,x=>`${x.type} · ${x.date} · ${x.invoiceNo||x.ddtNo||x.orderNo||""}`],["Alias",results.aliases,x=>`${x.aliasType} · ${x.supplierCode||""} · ${x.supplierDescription||""}`],["Documenti",results.documents,x=>`${x.documentDirection} · ${x.documentNo||""} · ${x.originalFileName||""}`]];
  let has=false; entries.forEach(([title,items,fmt])=>{ if(!items.length) return; has=true; const g=el("div",{"class":"result-group"}); g.appendChild(el("div",{"style":"font-weight:700;margin-bottom:8px"},`${title} (${items.length})`)); items.slice(0,6).forEach(it=>g.appendChild(el("div",{"class":"result-item"},fmt(it)))); wrap.appendChild(g); });
  if(!has) wrap.appendChild(el("div",{"class":"small"},"Nessun risultato."));
}
function showView(name){
  if(!canView(name)) return;
  $$(".view").forEach(v=>v.classList.add("hidden")); $(`#view-${name}`).classList.remove("hidden");
  $$(".nav button").forEach(b=>b.classList.toggle("active", b.dataset.view===name));
  ({dashboard:renderDashboard,suppliers:renderSuppliers,clients:renderClients,warehouses:renderWarehouses,products:renderProducts,aliases:renderAliases,stocks:renderStocks,movements:renderMovements,import:renderImport,documents:renderDocuments,users:renderUsers})[name]?.();
}
function bindCrudForm(formSelector, endpoint, fields, after){
  $(formSelector).onsubmit=async e=>{ e.preventDefault(); const payload={}; fields.forEach(f=>payload[f]=$(formSelector+` [name="${f}"]`).value); await api(`/api/${endpoint}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)}); await loadBootstrap(); after(); e.target.reset(); };
}
function renderSuppliers(){ const q=$("#suppliers-search").value||""; const b=$("#suppliers-body"); b.innerHTML=""; filterList(state.db.suppliers,q,["name","vat","email","phone","contact","notes"]).forEach(s=>b.appendChild(el("tr",{},[el("td",{},s.name),el("td",{},s.vat||""),el("td",{},s.email||""),el("td",{},s.phone||""),el("td",{},s.notes||"")]))); }
function renderClients(){ const q=$("#clients-search").value||""; const b=$("#clients-body"); b.innerHTML=""; filterList(state.db.clients,q,["name","vat","email","phone","contact","notes"]).forEach(s=>b.appendChild(el("tr",{},[el("td",{},s.name),el("td",{},s.vat||""),el("td",{},s.email||""),el("td",{},s.phone||""),el("td",{},s.notes||"")]))); }
function renderWarehouses(){ const q=$("#warehouses-search").value||""; const b=$("#warehouses-body"); b.innerHTML=""; filterList(state.db.warehouses,q,["name","city","address","active"]).forEach(w=>b.appendChild(el("tr",{},[el("td",{},w.name),el("td",{},w.city||""),el("td",{},w.address||""),el("td",{},String(w.active))]))); }
function renderProducts() {
  const q = $("#products-search").value || "";
  const b = $("#products-body");
  b.innerHTML = "";

  filterList(state.db.products, q, ["name","sku","category","color","size","notes"]).forEach(p => {
    const tr = el("tr", {}, [
      el("td", {}, p.name),
      el("td", {}, p.sku || ""),
      el("td", {}, p.category || ""),
      el("td", {}, p.color || ""),
      el("td", {}, p.size || "")
    ]);

    const tdActions = el("td");
    const editBtn = el("button", { class: "btn secondary", type: "button", style: "margin-right:8px" }, "Modifica");
    editBtn.onclick = () => fillProductForm(p);

    const deleteBtn = el("button", { class: "btn secondary", type: "button" }, "Elimina");
    deleteBtn.onclick = () => deleteProduct(p);

    tdActions.appendChild(editBtn);
    tdActions.appendChild(deleteBtn);
    tr.appendChild(tdActions);

    b.appendChild(tr);
  });
}
function renderAliases(){
  const q=$("#aliases-search").value||""; $("#alias-supplierId").innerHTML=`<option value="">Seleziona fornitore</option>`+state.db.suppliers.map(s=>`<option value="${s.id}">${s.name}</option>`).join(""); $("#alias-productId").innerHTML=`<option value="">Seleziona articolo principale</option>`+state.db.products.map(p=>`<option value="${p.id}">${p.name}</option>`).join("");
  const b=$("#aliases-body"); b.innerHTML="";
  filterList(state.db.aliases,q,["aliasType","supplierCode","ean","supplierDescription",x=>supplierName(x.supplierId),x=>productName(x.productId)]).forEach(a=>b.appendChild(el("tr",{},[el("td",{},a.aliasType||"supplier"),el("td",{},supplierName(a.supplierId)||"-"),el("td",{},a.supplierCode||""),el("td",{},a.supplierDescription||""),el("td",{},productName(a.productId))])));
}
function renderStocks(){
  const q=$("#stocks-search").value||""; const b=$("#stocks-body"); b.innerHTML="";
  filterList(state.db.stocks,q,[x=>warehouseName(x.warehouseId),x=>productName(x.productId),x=>state.db.products.find(p=>Number(p.id)===Number(x.productId))?.sku,"qty","minQty"]).forEach(s=>{
    const tr=el("tr"); tr.appendChild(el("td",{},warehouseName(s.warehouseId))); tr.appendChild(el("td",{},productName(s.productId))); tr.appendChild(el("td",{},String(s.qty))); tr.appendChild(el("td",{},String(s.minQty||0)));
    const td=el("td"); const q1=el("input",{type:"number",value:String(s.qty),style:"width:90px"}); const q2=el("input",{type:"number",value:String(s.minQty||0),style:"width:90px"}); const btn=el("button",{"class":"btn secondary",type:"button"},"Salva"); btn.onclick=async()=>{ await api(`/api/stocks/${s.id}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({qty:Number(q1.value),minQty:Number(q2.value)})}); await loadBootstrap(); renderStocks(); renderDashboard(); }; td.appendChild(q1); td.appendChild(q2); td.appendChild(btn); tr.appendChild(td); b.appendChild(tr);
  });
}
function populateMovementForm(){
  $("#movement-warehouseId").innerHTML=state.db.warehouses.map(w=>`<option value="${w.id}">${w.name}</option>`).join("");
  $("#movement-destinationWarehouseId").innerHTML=`<option value="">Nessuno</option>`+state.db.warehouses.map(w=>`<option value="${w.id}">${w.name}</option>`).join("");
  $("#movement-partnerId").innerHTML=`<option value="">Nessuno</option>`+[...state.db.suppliers.map(x=>`<option value="supplier:${x.id}">Fornitore · ${x.name}</option>`),...state.db.clients.map(x=>`<option value="client:${x.id}">Cliente · ${x.name}</option>`)].join("");
  $("#movement-rows").innerHTML=""; addMovementRow();
}
function addMovementRow(){
  const w=$("#movement-rows");
  const row=el("div",{"class":"form-grid-4 movement-row","style":"margin-bottom:10px"},[
    el("select",{"class":"movement-productId"},state.db.products.map(p=>el("option",{value:String(p.id)},`${p.name} · ${p.sku||""}`))),
    el("input",{"class":"movement-qty",type:"number",min:"1",value:"1"}),
    el("select",{"class":"movement-source"},[
      el("option",{value:"warehouse"},"Dal nostro magazzino"),
      el("option",{value:"supplier"},"Spedito dal fornitore")
    ]),
    el("button",{"class":"btn secondary",type:"button"},"Rimuovi")
  ]);
  row.querySelector("button").onclick=()=>row.remove();
  w.appendChild(row);
}
function renderMovements(){
  const q=$("#movements-search").value||""; const b=$("#movements-body"); b.innerHTML="";
  filterList(state.db.movements,q,["type","date","orderNo","invoiceNo","ddtNo","notes",x=>warehouseName(x.warehouseId),x=>partnerName(x.partnerType,x.partnerId),x=>(x.rows||[]).map(r=>`${productName(r.productId)} ${r.qty} ${r.fulfillmentSource}`).join(" ")]).forEach(m=>{
    const badgeClass=m.type==="carico"?"badge-green":m.type==="scarico"?"badge-red":"badge-amber";
    b.appendChild(el("tr",{},[
      el("td",{},[el("span",{"class":"badge "+badgeClass},m.type)]),
      el("td",{},m.date),
      el("td",{},warehouseName(m.warehouseId)),
      el("td",{},partnerName(m.partnerType,m.partnerId)||"-"),
      el("td",{},[m.orderNo||"-"," / ",m.invoiceNo||"-"," / ",m.ddtNo||"-"]),
      el("td",{},(m.rows||[]).map(r=>`${productName(r.productId)} (${r.qty}) [${r.fulfillmentSource==="warehouse"?"magazzino":"fornitore"}]`).join(" • "))
    ]));
  });
}
function renderDocuments(){
  const q=$("#documents-search").value||""; const b=$("#documents-body"); b.innerHTML="";
  filterList(state.db.imports,q,["documentDirection","documentType","documentNo","documentDate","originalFileName","status",x=>supplierName(x.supplierId),x=>clientName(x.clientId)]).forEach(d=>{
    const tr=el("tr");
    tr.appendChild(el("td",{},d.documentDirection||""));
    tr.appendChild(el("td",{},supplierName(d.supplierId)||clientName(d.clientId)||"-"));
    tr.appendChild(el("td",{},d.documentType||""));
    tr.appendChild(el("td",{},d.documentNo||""));
    tr.appendChild(el("td",{},d.documentDate||""));
    tr.appendChild(el("td",{},d.originalFileName||""));
    tr.appendChild(el("td",{},d.status||""));
    const td=el("td"); if(d.storedFile) td.appendChild(el("a",{href:d.storedFile,target:"_blank",class:"link"},"Apri file")); else td.textContent="-"; tr.appendChild(td); b.appendChild(tr);
  });
}
function guessProductIdByAlias(row, direction, supplierId){
  return guessProductIdSmart(row, direction, supplierId);
}
function loadDemoRows(){
  const direction=$("#import-direction").value;
  const supplierId=Number($("#import-supplierId").value||0);
  if(direction==="supplier"){
    state.importRows=[
      {ean:"",supplierCode:"5500633",description:"JOLLY LENZ. 240x290 BIANCO ST FTC",qty:12,action:"map",productId:guessProductIdSmart({supplierCode:"5500633",description:"JOLLY LENZ. 240x290 BIANCO ST FTC"},direction,supplierId),createAlias:true,fulfillmentSource:"warehouse"},
      {ean:"",supplierCode:"8301163",description:"LENZ. JOLLY U. B.CO DA 5 R 240X290",qty:10,action:"map",productId:guessProductIdSmart({supplierCode:"8301163",description:"LENZ. JOLLY U. B.CO DA 5 R 240X290"},direction,supplierId),createAlias:true,fulfillmentSource:"warehouse"},
      {ean:"",supplierCode:"",description:"Spese spedizione",qty:1,action:"ignore",productId:"",createAlias:false,fulfillmentSource:"supplier"}
    ];
  } else {
    state.importRows=[
      {ean:"",supplierCode:"TOPMOR1P",description:"Topper superior Morfeo 80x195",qty:1,action:"map",productId:guessProductIdSmart({supplierCode:"TOPMOR1P",description:"Topper superior Morfeo 80x195"},direction,supplierId),createAlias:true,fulfillmentSource:"warehouse"},
      {ean:"",supplierCode:"TOPMORM",description:"Topper superior Morfeo 160x195",qty:1,action:"map",productId:guessProductIdSmart({supplierCode:"TOPMORM",description:"Topper superior Morfeo 160x195"},direction,supplierId),createAlias:true,fulfillmentSource:"supplier"},
      {ean:"",supplierCode:"BarksKitSaponetta",description:"Kit Barks Saponetta Box 200",qty:1,action:"map",productId:guessProductIdSmart({supplierCode:"BarksKitSaponetta",description:"Kit Barks Saponetta Box 200"},direction,supplierId),createAlias:true,fulfillmentSource:"warehouse"},
      {ean:"",supplierCode:"BarksKitBagnodoccia",description:"Kit Barks Bagnodoccia Box 200",qty:1,action:"map",productId:404,createAlias:true,fulfillmentSource:"warehouse"},
      {ean:"",supplierCode:"BarksKitShampoo",description:"Kit Barks Shampoo Box 200",qty:1,action:"map",productId:404,createAlias:true,fulfillmentSource:"warehouse"},
      {ean:"",supplierCode:"SPEDY",description:"Spedizione Variabile",qty:1,action:"ignore",productId:"",createAlias:false,fulfillmentSource:"supplier"}
    ];
  }
  renderImportRowsTable();
}
function renderImport(){
  $("#import-supplierId").innerHTML=`<option value="">Seleziona fornitore</option>`+state.db.suppliers.map(s=>`<option value="${s.id}">${s.name}</option>`).join("");
  $("#import-clientId").innerHTML=`<option value="">Seleziona cliente</option>`+state.db.clients.map(c=>`<option value="${c.id}">${c.name}</option>`).join("");
  $("#import-warehouseId").innerHTML=state.db.warehouses.map(w=>`<option value="${w.id}">${w.name}</option>`).join("");
  toggleDirectionFields();
  renderImportRowsTable();
}
function toggleDirectionFields(){
  const dir=$("#import-direction").value;
  $("#import-supplier-wrap").classList.toggle("hidden", dir!=="supplier");
  $("#import-client-wrap").classList.toggle("hidden", dir!=="client");
  $("#import-confirm-label").textContent=dir==="supplier"?"Conferma carico da documento":"Conferma scarico da documento";
}
function checkRowAvailability(row){
  const direction = $("#import-direction").value;
  if(!row.productId) return { ok:true, message:"Seleziona articolo" };
  if(row.action === "ignore") return { ok:true, message:"Riga ignorata" };
  if(row.fulfillmentSource !== "warehouse") {
    return { ok:true, message: direction === "supplier" ? "Spedito direttamente al cliente" : "Spedito dal fornitore" };
  }
  const wh = Number($("#import-warehouseId").value || 301);
  const stock = state.db.stocks.find(s => Number(s.warehouseId)===wh && Number(s.productId)===Number(row.productId));
  const qty = Number(stock?.qty || 0);
  if(direction === "supplier") {
    return { ok:true, message:`+${row.qty} entreranno in magazzino` };
  }
  if(qty >= Number(row.qty || 0)) return { ok:true, message:`Disponibili ${qty} → dopo scarico ${qty - Number(row.qty || 0)}` };
  return { ok:false, message:`Disponibili ${qty}, richiesti ${row.qty}` };
}
function renderImportRowsTable(){
  const q=$("#import-rows-search").value||""; const b=$("#import-rows-body"); b.innerHTML="";
  filterList(state.importRows,q,["ean","supplierCode","description","qty","action",x=>productName(x.productId),x=>x.fulfillmentSource]).forEach((r,idx)=>{
    const tr=el("tr");
    tr.appendChild(el("td",{},String(idx+1)));
    tr.appendChild(el("td",{},r.ean||""));
    tr.appendChild(el("td",{},r.supplierCode||""));
    tr.appendChild(el("td",{},r.description||""));
    tr.appendChild(el("td",{},String(r.qty||"")));
    tr.appendChild(el("td",{},r.action||"map"));
    const tdP=el("td"); const sel=el("select"); sel.appendChild(el("option",{value:""},"Seleziona articolo")); state.db.products.forEach(p=>sel.appendChild(el("option",{value:String(p.id)},p.name))); sel.value=r.productId||""; sel.onchange=()=>{ r.productId=Number(sel.value)||""; renderImportRowsTable(); }; tdP.appendChild(sel); tr.appendChild(tdP);
    const tdSource=el("td");
    const direction = $("#import-direction").value;
    const cb=el("input",{type:"checkbox",style:"width:auto;margin-right:6px"}); cb.checked=(r.fulfillmentSource||"warehouse")==="warehouse";
    cb.onchange=()=>{ r.fulfillmentSource=cb.checked?"warehouse":"supplier"; renderImportRowsTable(); };
    const mainLabel = direction === "supplier" ? "carica a magazzino" : "scarica da magazzino";
    tdSource.appendChild(el("label",{},[cb, mainLabel]));
    let originText = "";
    if(cb.checked){
      originText = direction === "supplier" ? "Origine: entra nel tuo magazzino" : "Origine: Magazzino";
    } else {
      originText = direction === "supplier" ? "Origine: spedito direttamente al cliente" : "Origine: Fornitore";
    }
    tdSource.appendChild(el("div",{"class":"small"},originText));
    tr.appendChild(tdSource);

    const tdStatus=el("td");
    const availability=checkRowAvailability(r);
    tdStatus.appendChild(el("div",{"class":availability.ok?"ok":"warning"},availability.message));
    tr.appendChild(tdStatus);

    const tdA=el("td");
    const ign=el("button",{"class":"btn secondary",type:"button"},"Ignora"); ign.onclick=()=>{ r.action="ignore"; renderImportRowsTable(); };
    const map=el("button",{"class":"btn secondary",type:"button"},"Associa"); map.onclick=()=>{ r.action="map"; renderImportRowsTable(); };
    const alias=el("label",{"class":"small",style:"display:block;margin-top:8px"},[el("input",{type:"checkbox",style:"width:auto;margin-right:6px"}),"salva alias"]);
    alias.querySelector("input").checked=!!r.createAlias; alias.querySelector("input").onchange=e=>{ r.createAlias=e.target.checked; };
    tdA.appendChild(ign); tdA.appendChild(map); tdA.appendChild(alias);
    tr.appendChild(tdA); b.appendChild(tr);
  });
}

async function renderUsers(){
  if(!canView("users")) return;
  const tbody = $("#users-body");
  if (!tbody) return;
  tbody.innerHTML = "";
  const users = await api("/api/users");
  users.forEach(u => {
    tbody.appendChild(el("tr",{},[
      el("td",{},u.name),
      el("td",{},u.email),
      el("td",{},u.role),
      el("td",{},u.roleKey)
    ]));
  });
  const roleSelect = $("#user-roleKey");
  if (roleSelect) {
    roleSelect.innerHTML = (state.db.roles || []).map(r => `<option value="${r.key}">${r.name}</option>`).join("");
  }
}

async function init(){
  await loadBootstrap();
  bindCrudForm("#form-supplier","suppliers",["name","vat","email","phone","contact","notes"], async()=>{ await loadBootstrap(); renderSuppliers(); renderDashboard(); renderImport(); renderAliases(); });
  bindCrudForm("#form-client","clients",["name","vat","email","phone","contact","notes"], async()=>{ await loadBootstrap(); renderClients(); renderImport(); });
  bindCrudForm("#form-warehouse","warehouses",["name","city","address","active"], async()=>{ await loadBootstrap(); renderWarehouses(); renderImport(); });
const productForm = $("#form-product");
productForm.onsubmit = async e => {
  e.preventDefault();

const payload = {
  name: productForm.querySelector('[name="name"]').value,
  sku: productForm.querySelector('[name="sku"]').value,
  category: productForm.querySelector('[name="category"]').value,
  color: productForm.querySelector('[name="color"]').value,
  size: productForm.querySelector('[name="size"]').value,
  notes: productForm.querySelector('[name="notes"]').value,

  purchasePriceNet: productForm.querySelector('[name="purchasePriceNet"]').value,
  purchasePriceGross: productForm.querySelector('[name="purchasePriceGross"]').value,
  salePriceNet: productForm.querySelector('[name="salePriceNet"]').value,
  salePriceGross: productForm.querySelector('[name="salePriceGross"]').value,
  vatRate: productForm.querySelector('[name="vatRate"]').value
};

  const productId = productForm.querySelector('[name="id"]').value;

  try {
    if (productId) {
      const confirmed = confirm(`Confermi la modifica del prodotto "${payload.name}"?`);
      if (!confirmed) return;

      await api(`/api/products/${productId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      alert(`Operazione completata: prodotto "${payload.name}" modificato con successo.`);
    } else {
      await api(`/api/products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      alert(`Operazione completata: prodotto "${payload.name}" creato con successo.`);
    }

    await loadBootstrap();
    renderProducts();
    renderAliases();
    renderStocks();
    renderDashboard();
    resetProductForm();
  } catch (err) {
    alert(err.message || "Errore salvataggio prodotto");
  }
};

$("#product-cancel-edit").onclick = () => resetProductForm();  bindCrudForm("#form-alias","aliases",["aliasType","supplierId","supplierCode","ean","supplierDescription","productId"], async()=>{ await loadBootstrap(); renderAliases(); });
  const userForm = $("#form-user");
  if (userForm) {
    userForm.onsubmit = async e => {
      e.preventDefault();
      await api("/api/users", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          name: $("#user-name").value,
          email: $("#user-email").value,
          password: $("#user-password").value,
          roleKey: $("#user-roleKey").value
        })
      });
      await loadBootstrap();
      await renderUsers();
      userForm.reset();
      alert("Utente creato.");
    };
  }


  $("#login-form").onsubmit=async e=>{ e.preventDefault(); try{ const result=await api("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:$("#login-email").value,password:$("#login-password").value})}); state.currentUser=result.user; $("#login-view").classList.add("hidden"); $("#app-view").classList.remove("hidden"); $("#current-user").textContent=`${result.user.name} · ${result.user.role}`; populateMovementForm(); applyPermissionsUI(); showView("dashboard"); }catch(err){ $("#login-error").textContent=err.message; $("#login-error").classList.remove("hidden"); } };
  $("#logout-btn").onclick=()=>location.reload();
  $$(".nav button").forEach(b=>b.onclick=()=>showView(b.dataset.view));
  ["suppliers","clients","warehouses","products","aliases","stocks","movements","documents"].forEach(name=>{ const inp=document.getElementById(`${name}-search`); if(inp) inp.addEventListener("input",()=>({suppliers:renderSuppliers,clients:renderClients,warehouses:renderWarehouses,products:renderProducts,aliases:renderAliases,stocks:renderStocks,movements:renderMovements,documents:renderDocuments}[name])()); });
  $("#import-rows-search").addEventListener("input", renderImportRowsTable);
  $("#global-search-input").addEventListener("input", async e=>{ const q=e.target.value.trim(); if(!q){ $("#global-search-results").innerHTML=""; return; } renderGlobalSearchResults(await api(`/api/search?q=${encodeURIComponent(q)}`)); });

  $("#add-movement-row").onclick=addMovementRow;
  $("#form-movement").onsubmit=async e=>{
    e.preventDefault();
    const partnerRaw=$("#movement-partnerId").value; let partnerType=null, partnerId=null; if(partnerRaw){ const [t,id]=partnerRaw.split(":"); partnerType=t; partnerId=Number(id); }
    const rows=$$(".movement-row").map(row=>({ productId:Number(row.querySelector(".movement-productId").value), qty:Number(row.querySelector(".movement-qty").value), fulfillmentSource:row.querySelector(".movement-source").value })).filter(r=>r.productId && r.qty>0);
    await api("/api/movements",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:$("#movement-type").value,date:$("#movement-date").value,warehouseId:Number($("#movement-warehouseId").value),destinationWarehouseId:$("#movement-destinationWarehouseId").value||null,partnerType,partnerId,orderNo:$("#movement-orderNo").value,invoiceNo:$("#movement-invoiceNo").value,ddtNo:$("#movement-ddtNo").value,notes:$("#movement-notes").value,rows})});
    await loadBootstrap(); populateMovementForm(); $("#form-movement").reset(); $("#movement-date").value=new Date().toISOString().slice(0,10); renderMovements(); renderStocks(); renderDashboard(); alert("Movimento salvato.");
  };
  $("#movement-date").value=new Date().toISOString().slice(0,10);

  $("#import-direction").addEventListener("change", ()=>{ toggleDirectionFields(); state.importRows=[]; renderImportRowsTable(); });
  $("#import-upload-form").onsubmit=async e=>{
    e.preventDefault();
    const fd=new FormData(); fd.append("documentDirection", $("#import-direction").value); if($("#import-supplierId").value) fd.append("supplierId", $("#import-supplierId").value); if($("#import-clientId").value) fd.append("clientId", $("#import-clientId").value);
    fd.append("documentType", $("#import-documentType").value); fd.append("documentNo", $("#import-documentNo").value); fd.append("documentDate", $("#import-documentDate").value); fd.append("warehouseId", $("#import-warehouseId").value); if($("#import-file").files[0]) fd.append("document", $("#import-file").files[0]);
    const res=await fetch("/api/imports/upload",{method:"POST",body:fd}); const data=await res.json(); state.currentImportId=data.id;
    if (data.detectedSupplierId && !$("#import-supplierId").value) $("#import-supplierId").value = String(data.detectedSupplierId);
    const direction=$("#import-direction").value; const supplierId=Number($("#import-supplierId").value||data.detectedSupplierId||0);
    if(data.parsedRows && data.parsedRows.length){
      state.importRows = data.parsedRows.map(r => ({...r, productId: r.productId || guessProductIdSmart(r, direction, supplierId), createAlias: r.createAlias !== false, fulfillmentSource: r.fulfillmentSource || "warehouse", action: r.action || "map"}));
      $("#import-status").textContent=`Documento salvato: ${data.originalFileName || "senza file"} · Parser: ${data.parser || "n/d"} · Righe lette: ${data.parsedRows.length}`;
    } else {
      state.importRows = [];
      $("#import-status").textContent=`Documento salvato: ${data.originalFileName || "senza file"} · Nessuna riga prodotto letta automaticamente. Puoi aggiungerla manualmente.`;
    }
    renderImportRowsTable();
    await loadBootstrap(); renderDocuments();
  };
  $("#import-add-row").onclick=()=>{ state.importRows.push({ean:"",supplierCode:"",description:"",qty:1,action:"map",productId:"",createAlias:true,fulfillmentSource:"warehouse"}); renderImportRowsTable(); };
  $("#import-confirm").onclick=async ()=>{
    if(!state.currentImportId) return alert("Carica prima un documento.");
    await api(`/api/imports/${state.currentImportId}/rows`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({rows:state.importRows})});
    await api(`/api/imports/${state.currentImportId}/confirm`,{method:"POST"});
    await loadBootstrap(); renderAliases(); renderStocks(); renderMovements(); renderDashboard(); renderDocuments(); alert("Documento confermato. Le associazioni salvate verranno riutilizzate automaticamente nei prossimi carichi o scarichi con stesso codice o descrizione simile.");
  };
}
window.addEventListener("DOMContentLoaded", init);
