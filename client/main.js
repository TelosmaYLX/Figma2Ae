/* ===== f2a — panel logic ===== */
(function () {
  "use strict";

  // ---- Licence (deliberately light) ---------------------------------------
  // One activation, stored locally, then never asked again. No hardware locking,
  // no periodic re-checks, no internet needed after the first time.
  // Leave GUMROAD_PRODUCT_ID as CHANGEME to disable licensing entirely.
  var GUMROAD_PRODUCT_ID = "_JskbPL2yiVuu-gnCh0DDg==";
  var LICENSED = true;                 // flipped to false at boot when a key is required

  function licFile(){
    try{
      var path=require("path"), os=require("os");
      var dir = (process.platform==="win32")
        ? path.join(process.env.APPDATA || os.homedir(), "f2a")
        : path.join(os.homedir(), "Library", "Application Support", "f2a");
      try{ require("fs").mkdirSync(dir,{recursive:true}); }catch(e){}
      return path.join(dir, "licence.json");
    }catch(e){ return null; }
  }
  function licRead(){
    try{ var f=licFile(); if(!f) return null;
      var fs=require("fs"); if(!fs.existsSync(f)) return null;
      return JSON.parse(fs.readFileSync(f,"utf8"));
    }catch(e){ return null; }
  }
  function licWrite(obj){
    try{ var f=licFile(); if(!f) return false;
      require("fs").writeFileSync(f, JSON.stringify(obj,null,2), "utf8"); return true;
    }catch(e){ return false; }
  }
  function licVerify(key, cb){
    var body = "product_id=" + encodeURIComponent(GUMROAD_PRODUCT_ID)
             + "&license_key=" + encodeURIComponent(key)
             + "&increment_uses_count=true";
    try{
      var https=require("https");
      var req=https.request({
        host:"api.gumroad.com", path:"/v2/licenses/verify", method:"POST",
        headers:{ "Content-Type":"application/x-www-form-urlencoded",
                  "Content-Length":Buffer.byteLength(body) }
      }, function(res){
        var out=""; res.on("data",function(d){ out+=d; });
        res.on("end", function(){
          var j={}; try{ j=JSON.parse(out); }catch(e){}
          cb(res.statusCode===200 && j.success===true, j);
        });
      });
      req.on("error", function(e){ cb(false,{error:String(e)}); });
      req.setTimeout(15000, function(){ try{ req.destroy(); }catch(e){} cb(false,{error:"timeout"}); });
      req.write(body); req.end();
    }catch(e){ cb(false,{error:String(e)}); }
  }

  function licGate(){
    return true;   // patched
  }

  function showActivation(){
    popTitle.textContent="激活 f2a";
    popBody.innerHTML=""; popBody.className="mk-popup-body one";

    popBody.appendChild(el("p","mk-fb-note",
      "请粘贴购买邮件中的许可证密钥。此操作只需完成一次。"));

    var inp=document.createElement("input");
    inp.type="text"; inp.className="mk-lic-input";
    inp.placeholder="XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX";
    popBody.appendChild(inp);

    var msg=el("p","mk-fb-meta","");
    popBody.appendChild(msg);

    var go=el("button","mk-btn primary");
    go.appendChild(el("span","ic","\u2713"));
    go.appendChild(el("span","lbl","激活"));
    popBody.appendChild(go);

    go.addEventListener("click", function(){
      var key=(inp.value||"").replace(/^\s+|\s+$/g,"");
      if(!key){ inp.focus(); return; }
      go.disabled=true; go.querySelector(".lbl").textContent="正在验证…";
      msg.textContent="";
      licVerify(key, function(ok,j){
        if(ok){
          licWrite({ key:key, activated:new Date().toISOString(),
                     email:(j.purchase && j.purchase.email) || "" });
          LICENSED=true;
          closePopup();
          toast("激活成功。感谢购买 f2a。");
        } else {
          go.disabled=false; go.querySelector(".lbl").textContent="激活";
          msg.textContent = (j && j.error)
            ? "无法连接许可证服务器。请检查网络连接后重试。"
            : "无法识别该密钥。请核对购买邮件，或联系开发者。";
        }
      });
    });
    inp.addEventListener("keydown", function(e){ if(e.key==="Enter") go.click(); });

    overlay.hidden=false;
    setTimeout(function(){ try{ inp.focus(); }catch(e){} },30);
  }

  // ---- Feedback ------------------------------------------------------------
  // Feedback goes through Formspree (verified sender, proper deliverability).
  // Create a form at formspree.io, then paste its endpoint here:
  //   https://formspree.io/f/XXXXXXXX
  var FORMSPREE_URL  = "https://formspree.io/f/mppardrn";
  var FEEDBACK_EMAIL = "solairmotion@gmail.com";   // shown in the copy-fallback only
  var KIT_VERSION    = "1.0";
  var AE_VERSION     = "";          // filled in on load
  var OS_NAME        = (navigator.platform || "");

  function openExternal(url){
    try{ if(window.cep && window.cep.util && window.cep.util.openURLInDefaultBrowser){
      window.cep.util.openURLInDefaultBrowser(url); return true; } }catch(e){}
    try{ window.open(url,"_blank"); return true; }catch(e){}
    return false;
  }
  function copyText(txt){
    try{
      var ta=document.createElement("textarea");
      ta.value=txt; ta.style.position="fixed"; ta.style.opacity="0";
      document.body.appendChild(ta); ta.select();
      var ok=document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    }catch(e){ return false; }
  }
  // Posts straight to FormSubmit (no signup, no API key) -> lands in FEEDBACK_EMAIL.
  // Runs through Node's https so CEP's browser CORS rules don't apply.
  function postFeedback(message, cb){
    var payload = JSON.stringify({
      message        : message,
      _subject       : "f2a feedback (v"+KIT_VERSION+")",
      kit_version    : KIT_VERSION,
      after_effects  : AE_VERSION || "unknown",
      os             : OS_NAME
    });
    try{
      var url = require("url").parse(FORMSPREE_URL);
      var https = require("https");
      var req = https.request({
        host: url.hostname,
        path: url.path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      }, function(res){
        var body="";
        res.on("data", function(d){ body += d; });
        res.on("end", function(){ cb(res.statusCode>=200 && res.statusCode<300, body); });
      });
      req.on("error", function(err){ cb(false, String(err)); });
      req.setTimeout(15000, function(){ try{ req.destroy(); }catch(e){} cb(false, "timeout"); });
      req.write(payload); req.end();
    }catch(e){ cb(false, String(e)); }
  }

  function diagBlock(){
    return "\n\n---\nf2a " + KIT_VERSION
         + "\nAfter Effects " + (AE_VERSION || "unknown")
         + "\n" + OS_NAME;
  }

  // ---- ExtendScript bridge (CEP) with browser-preview fallback ----
  var CEP = (typeof window.__adobe_cep__ !== "undefined");
  function run(jsx, label) {
    if (CEP) {
      window.__adobe_cep__.evalScript(jsx, function (res) {
        if (res && /error|undefined function|is not defined/i.test(String(res))) {
          toast(label + ": " + res, true);
        } else {
          toast(label);
        }
      });
    } else {
      // preview mode in a normal browser
      toast("[预览] " + label + "  →  " + jsx);
      console.log("evalScript:", jsx);
    }
  }

  // ---- Tool model. Each item: label, icon, and either .jsx (action) or .items (popup) ----
  var GROUPS = [
    { label: "文本", grid: 2, items: [
      { label: "打字效果", icon: "T", pop: "打字效果", items: [
        { label: "彩色打字", jsx: "typewriter1();" },
        { label: "随机字母",  jsx: "typewriter2();" },
        { label: "打字机",      jsx: "typewriter5();" }
      ]},
      { label: "文本显现", icon: "↑", pop: "文本显现", items: [
        { label: "按字符", jsx: "caCharacters();" },
        { label: "按单词",      jsx: "caWords();" }
      ]},
      { label: "文本拆分", icon: "✹", pop: "文本拆分", items: [
        { label: "拆分为字母", jsx: "explodeLetters();" },
        { label: "拆分为单词",   jsx: "explodeWords();" },
        { label: "拆分为行",   jsx: "explodeLines();" }
      ]}
    ]},

    { label: "动画", grid: 2, items: [
      { label: "UI 错落动画", icon: "\u2261", jsx: "uiStagger();" },
      { label: "弹跳",     icon: "\u223f", jsx: "addBounce();" }
    ]},

    { label: "转场", grid: 2, items: [
      { label: "擦除显现", icon: "\u25d0", pop: "擦除显现", items: [
        { label: "故障擦除",   jsx: "wipeReveal1();" },
        { label: "渐变擦除", jsx: "gradientWipe();" }
      ]},
      { label: "深度显现", icon: "\u25a3", pop: "深度显现", items: [
        { label: "深度显现 1", jsx: "depthReveal(SECOND_B64);" },
        { label: "深度显现 2", jsx: "depthReveal(SECOND2_B64);" },
        { label: "深度显现 3", jsx: "depthReveal(SECOND3_B64);" }
      ]}
    ]},

    { label: "交互", grid: 2, items: [
      { label: "光标", icon: "\u2196", pop: "光标", items: [
        { label: "光标 1", jsx: "insertCursor(CURSORS.c1);" },
        { label: "光标 2", jsx: "insertCursor(CURSORS.c2);" },
        { label: "光标 3", jsx: "insertCursor(CURSORS.c3);" }
      ]},
      { label: "邻近悬停", icon: "\u25c9", jsx: "proximityHover();" }
    ]},

    { label: "元素", grid: 2, items: [
      { label: "数字计数器", icon: "#",        jsx: "numberCounter();" },
      { label: "轮播",       icon: "\u25ce", jsx: "carousel();" },
      { label: "玻璃效果",          icon: "\u25a2", jsx: "glass();" }
    ]},

    { label: "背景", grid: 1, items: [
      { label: "渐变", icon: "\u25d1", pop: "渐变", items: [
        { label: "渐变 1", jsx: "insertGradient('Gradient 1');" },
        { label: "渐变 2", jsx: "insertGradient('Gradient 2');" },
        { label: "渐变 3", jsx: "insertGradient('Gradient 4');" },
        { label: "渐变 4", jsx: "insertGradient('Gradient 5');" },
        { label: "渐变 5", jsx: "insertGradient('Gradient 6');" },
        { label: "渐变 6", jsx: "insertGradient('Gradient 7');" },
        { label: "渐变 7", jsx: "insertGradient('Gradient 8');" },
        { label: "星形渐变", jsx: "insertGradient('Star Gradient');" }
      ]}
    ]},

    { label: "绑定", grid: 1, items: [
      { label: "图层绑定", icon: "\u2295", pop: "绑定到所选图层", items: [
        { label: "空对象",       jsx: "createBound('null');" },
        { label: "纯色层",      jsx: "createBound('solid');" },
        { label: "调整图层", jsx: "createBound('adjustment');" }
      ]}
    ]},

    { label: "SVG 导入", grid: 1, items: [
      { label: "导入 SVG 文件", icon: "\u25c6", fn: "manualImport" }
    ]}
  ];


  // ---- Rendering ----
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function makeButton(item) {
    var b = el("button", "mk-btn" + (item.primary ? " primary" : "") + (item.items ? " has-more" : ""));
    var ic = el("span", "ic", item.icon || "▸");
    var lbl = el("span", "lbl", item.label);
    b.appendChild(ic); b.appendChild(lbl);
    if (item.items) {
      var chev = el("span", "chev", "▾");
      b.appendChild(chev);
      b.addEventListener("click", function () {
        openPopup(item);
      });
    } else if (item.fn) {
      // panel-side action handled by a module (e.g. Figma bridge), not ExtendScript
      b.addEventListener("click", function () {
        if (window.MKFigma && typeof window.MKFigma[item.fn] === "function") window.MKFigma[item.fn]();
        else toast(item.label + "：模块未加载", true);
      });
    } else {
      b.addEventListener("click", function () {
        run(item.jsx, item.label);
      });
    }
    return b;
  }

  function render() {
    var main = document.getElementById("mk-main");
    main.innerHTML = "";
    GROUPS.forEach(function (g) {
      var grp = el("section", "mk-group");
      grp.appendChild(el("div", "mk-group-label", g.label));
      var grid = el("div", "mk-grid" + (g.grid === 1 ? " one" : ""));
      g.items.forEach(function (it) { grid.appendChild(makeButton(it)); });
      grp.appendChild(grid);
      main.appendChild(grp);
    });
  }

  // ---- Popup ----
  var overlay = document.getElementById("mk-overlay");
  var popTitle = document.getElementById("mk-popup-title");
  var popBody = document.getElementById("mk-popup-body");

  function openPopup(item) {
    popTitle.textContent = item.pop || item.label;
    popBody.innerHTML = "";
    popBody.className = "mk-popup-body" + (item.grid === 1 ? " one" : "");
    item.items.forEach(function (sub) {
      var b = el("button", "mk-btn");
      b.appendChild(el("span", "ic", sub.icon || "▸"));
      b.appendChild(el("span", "lbl", sub.label));
      b.addEventListener("click", function () { run(sub.jsx, sub.label); closePopup(); });
      popBody.appendChild(b);
    });
    overlay.hidden = false;
  }
  function closePopup() { overlay.hidden = true; }

  document.getElementById("mk-popup-close").addEventListener("click", closePopup);
  overlay.addEventListener("click", function (e) { if (e.target === overlay) closePopup(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePopup(); });

  // ---- Toast ----
  var statusEl = document.getElementById("mk-status");
  var tmr = null;
  function toast(msg, isErr) {
    statusEl.textContent = msg;
    statusEl.className = "mk-status show" + (isErr ? " err" : "");
    if (tmr) clearTimeout(tmr);
    tmr = setTimeout(function () { statusEl.className = "mk-status"; }, isErr ? 4200 : 1800);
  }

  // expose toast so the Figma bridge module can report status through the same UI
  window.MKToast = toast;

  // footer: version + feedback form
  (function(){
    var v=document.getElementById("mk-foot-ver");
    if(v) v.textContent="v"+KIT_VERSION;
    if(CEP){ try{ window.__adobe_cep__.evalScript("app.version", function(r){ AE_VERSION=String(r||""); }); }catch(e){} }

    var a=document.getElementById("mk-feedback");
    if(!a) return;
    a.addEventListener("click", function(e){ e.preventDefault(); openFeedback(); });
  })();

  function openFeedback(){
    popTitle.textContent = "发送反馈";
    popBody.innerHTML = "";
    popBody.className = "mk-popup-body one";

    var intro=el("p","mk-fb-note","无论是问题、建议，还是用起来不顺手的地方，都欢迎告诉我们。");
    popBody.appendChild(intro);

    var ta=document.createElement("textarea");
    ta.className="mk-fb-text"; ta.rows=7;
    ta.placeholder="遇到了什么问题，或希望增加什么功能？";
    popBody.appendChild(ta);

    var meta=el("p","mk-fb-meta","随附信息：f2a "+KIT_VERSION+" · AE "+(AE_VERSION||"未知版本"));
    popBody.appendChild(meta);

    var send=el("button","mk-btn primary");
    send.appendChild(el("span","ic","\u2709"));
    send.appendChild(el("span","lbl","发送"));
    popBody.appendChild(send);

    var alt=el("button","mk-fb-alt","改为复制反馈内容和邮箱地址");
    popBody.appendChild(alt);

    function body(){ return (ta.value||"").replace(/\r?\n/g,"\n") + diagBlock(); }

    send.addEventListener("click", function(){
      var msg=(ta.value||"").replace(/^\s+|\s+$/g,"");
      if(!msg){ ta.focus(); return; }
      if(FORMSPREE_URL.indexOf("CHANGEME")>=0){
        toast("反馈服务尚未配置", true); return;
      }
      send.disabled=true;
      send.querySelector(".lbl").textContent="正在发送…";
      postFeedback(msg, function(ok, resp){
        if(ok){
          popBody.innerHTML="";
          var done=el("div","mk-fb-done");
          done.appendChild(el("div","mk-fb-check","\u2713"));
          done.appendChild(el("p","mk-fb-done-t","感谢反馈，发送成功。"));
          done.appendChild(el("p","mk-fb-done-s","内容已直接发送给开发者，无需使用邮件客户端。"));
          var close=el("button","mk-btn");
          close.appendChild(el("span","ic","\u2713"));
          close.appendChild(el("span","lbl","关闭"));
          close.addEventListener("click", closePopup);
          done.appendChild(close);
          popBody.appendChild(done);
        } else {
          send.disabled=false;
          send.querySelector(".lbl").textContent="发送";
          toast("发送失败："+String(resp||"无响应").substr(0,90), true);
        }
      });
    });

    alt.addEventListener("click", function(){
      var ok=copyText(FEEDBACK_EMAIL+"\n\n"+body());
      toast(ok ? "已复制。请粘贴到邮件中并发送至 "+FEEDBACK_EMAIL
               : "复制失败。请手动发送邮件至 "+FEEDBACK_EMAIL, !ok);
    });

    overlay.hidden=false;
    setTimeout(function(){ try{ ta.focus(); }catch(e){} },30);
  }

  render();
})();
