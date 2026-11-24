/* ==========================================================================
   จับคู่รูปกับสินค้าอัตโนมัติ (ไม่ต้องใช้ไฟล์ mapping.json)
   - รับรูปหลายไฟล์ หรือไฟล์ .zip เดียว (สะดวกบน iPad) และ .json จับคู่แบบเดิม (ถ้ามี)
   - เทียบชื่อไฟล์กับ SKU / บาร์โค้ด / ชื่อสินค้า (และเลขท้าย SKU ถ้าเปิดตัวเลือก) พร้อมบอกว่าจับคู่ด้วยวิธีไหน
   - แสดงผลให้ตรวจก่อนอัปโหลด: จับคู่ได้ / กำกวม / ไม่พบ  • ย่อรูป (≤900px, JPEG) แปลง HEIC ของ iPad ให้ด้วย
   - อัปโหลดขึ้น Supabase Storage (bucket product-images) แล้วผูก imageUrl กับสินค้า
   ========================================================================== */
(function () {
  'use strict';
  const D = () => window.db || {};
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s == null ? '' : s).normalize('NFC').toLowerCase().replace(/[\s_\-.()\[\]{}'"\/\\,+]+/g, '');
  const baseName = (n) => String(n).replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  const isImg = (n) => /\.(jpe?g|png|webp|gif|heic|heif|bmp)$/i.test(n) && !/(^|\/)(__MACOSX|\.)/.test(n);
  const mimeOf = (n) => ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[String(n).split('.').pop().toLowerCase()] || '');
  const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u.trim());
  const RULE = { json: 'ตามไฟล์ JSON', sku: 'ตรงกับ SKU/บาร์โค้ด', name: 'ตรงกับชื่อสินค้า', 'part-sku': 'ส่วนของชื่อไฟล์ตรงกับ SKU/บาร์โค้ด', 'name-tail': 'ส่วนท้ายชื่อไฟล์ตรงกับชื่อสินค้า', 'name-head': 'ชื่อไฟล์ (ตัดเลขท้าย) ตรงกับชื่อสินค้า', num: 'เลขตรงกับเลขท้าย SKU (เดา)' };

  // ---------------- ดัชนีสินค้า ----------------
  function buildIndex() {
    const sku = new Map(), name = new Map(), num = new Map();
    const add = (m, k, p) => { if (!k) return; if (!m.has(k)) m.set(k, new Set()); m.get(k).add(p); };
    Object.values(D().products || {}).forEach(p => {
      if (!p || p.isDeleted) return;
      add(sku, norm(p.code), p); add(name, norm(p.name), p);
      (p.variants || []).forEach(v => {
        add(sku, norm(v.sku), p); add(sku, norm(v.barcode), p);
        if (v.sizeName) add(name, norm(p.name + ' ' + v.sizeName), p);
        const m = /(\d+)\s*$/.exec(String(v.sku || p.code || '')); if (m && parseInt(m[1], 10) > 0) add(num, String(parseInt(m[1], 10)), p);
      });
    });
    return { sku, name, num };
  }
  const list = (set) => (set ? [...set] : []);

  // ---------------- จับคู่ชื่อไฟล์ ----------------
  function matchOne(fileName, idx, opts, jsonMap) {
    const base = baseName(fileName), nb = norm(base), parts = base.split(/[_\-\s]+/).filter(Boolean);
    if (jsonMap && jsonMap.has(fileName)) {
      const c = list(idx.name.get(norm(jsonMap.get(fileName)))); if (c.length) return { rule: 'json', cands: c };
    }
    let c = list(idx.sku.get(nb)); if (c.length) return { rule: 'sku', cands: c };
    c = list(idx.name.get(nb)); if (c.length) return { rule: 'name', cands: c };
    for (const part of parts) { if (part.length < 3) continue; c = list(idx.sku.get(norm(part))); if (c.length) return { rule: 'part-sku', cands: c }; }
    for (let i = 1; i < parts.length; i++) { c = list(idx.name.get(norm(parts.slice(i).join(' ')))); if (c.length) return { rule: 'name-tail', cands: c }; }
    const head = base.replace(/[\s_\-]*\(?\d{1,3}\)?\s*$/, '');   // ตัดเลขลำดับรูปท้ายชื่อ เช่น "ข้อต่อ_2" "ข้อต่อ (3)"
    if (head && head !== base) { c = list(idx.name.get(norm(head))); if (c.length) return { rule: 'name-head', cands: c }; }
    if (opts.num) for (const part of parts) { if (!/^\d+$/.test(part)) continue; const k = String(parseInt(part, 10)); if (k === '0') continue; c = list(idx.num.get(k)); if (c.length) return { rule: 'num', cands: c }; }
    return { rule: null, cands: [] };
  }
  function matchAll(files, opts, jsonMap) {
    const idx = buildIndex(), items = [], claimed = new Map();
    files.forEach(f => {
      const m = matchOne(f.name, idx, opts, jsonMap), it = { f, rule: m.rule, p: null, status: 'none', cands: m.cands };
      if (m.cands.length === 1) {
        const p = m.cands[0];
        if (opts.skipHas && isHttp(p.imageUrl)) it.status = 'has';
        else if (claimed.has(p.id)) it.status = 'dup';
        else { it.status = 'ok'; it.p = p; claimed.set(p.id, it); }
      } else if (m.cands.length > 1) it.status = 'amb';
      items.push(it);
    });
    return items;
  }

  // ---------------- แหล่งไฟล์ (รูป/ZIP/JSON) ----------------
  async function loadZipLib() {
    if (window.JSZip) return window.JSZip;
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'; s.onload = res; s.onerror = () => rej(new Error('โหลดตัวอ่าน ZIP ไม่ได้ (ต้องออนไลน์)')); document.head.appendChild(s); });
    return window.JSZip;
  }
  async function collect(fileList) {
    const files = []; let jsonMap = null;
    for (const f of Array.from(fileList)) {
      const n = f.name || '';
      if (/\.zip$/i.test(n)) {
        const zip = await (await loadZipLib()).loadAsync(f);
        zip.forEach((path, entry) => { if (!entry.dir && isImg(path)) files.push({ name: path.split('/').pop(), getBlob: async () => new Blob([await entry.async('blob')], { type: mimeOf(path) }) }); });
      } else if (/\.json$/i.test(n)) {
        try { const o = JSON.parse(await f.text()); jsonMap = new Map(Object.entries(o).map(([prod, file]) => [String(file), prod])); } catch (e) { throw new Error('อ่านไฟล์ JSON ไม่ได้: ' + n); }
      } else if (isImg(n) || /^image\//.test(f.type || '')) files.push({ name: n, getBlob: async () => f });
    }
    return { files, jsonMap };
  }

  // ---------------- ย่อรูป ----------------
  async function toJpeg(blob, max) {
    if (blob.type === 'image/jpeg' && blob.size <= 350 * 1024) return blob;   // JPEG ที่เล็กอยู่แล้ว อัปโหลดตามเดิม (เร็วและไม่เสียคุณภาพ)
    try {
      const bmp = await createImageBitmap(blob);
      const sc = Math.min(1, max / Math.max(bmp.width, bmp.height)), w = Math.max(1, Math.round(bmp.width * sc)), h = Math.max(1, Math.round(bmp.height * sc));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(bmp, 0, 0, w, h); if (bmp.close) bmp.close();
      const out = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82)); if (out) return out;
    } catch (e) { /* ใช้ไฟล์เดิมถ้าเป็นชนิดที่ Storage รับ */ }
    if (/^image\/(jpeg|png|webp|gif)$/.test(blob.type)) return blob;
    throw new Error('แปลงรูปไม่ได้ (' + (blob.type || 'ไม่ทราบชนิด') + ')');
  }

  // ---------------- หน้าต่าง ----------------
  function frame(title, html, bind) {
    let el = document.getElementById('im-dlg');
    if (!el) {
      el = document.createElement('div'); el.id = 'im-dlg'; el.className = 'hf-ov';
      el.innerHTML = '<div class="hf-card"><div class="hf-head"><div id="im-title" class="hf-title"></div><button id="im-x" class="hf-x" aria-label="ปิด">✕</button></div><div id="im-body" class="hf-body"></div></div>';
      document.body.appendChild(el); el.querySelector('#im-x').onclick = () => { state.cancel = true; el.remove(); };
    }
    el.querySelector('#im-title').textContent = title;
    const b = el.querySelector('#im-body'); b.innerHTML = html; b.scrollTop = 0; if (bind) bind(b);
  }
  const state = { cancel: false };

  function stepPick() {
    state.cancel = false;
    frame('✨ จับคู่รูปกับสินค้าอัตโนมัติ',
      `<div class="hf-note"><b>ไม่ต้องใช้ไฟล์ JSON</b> ตั้งชื่อรูปให้ตรงกับ <b>SKU / บาร์โค้ด / ชื่อสินค้า</b> อย่างใดอย่างหนึ่ง เช่น <code>imp0372.jpg</code>, <code>8851234567890.jpg</code>, <code>ข้อต่อตรง 1 นิ้ว.jpg</code> หรือ <code>00012_ข้อต่อตรง 1 นิ้ว.jpg</code><br>เลือก <b>ไฟล์รูปหลายไฟล์</b> หรือ <b>ไฟล์ .zip เดียว</b> (สะดวกกว่าถ้ามีรูปจำนวนมาก) ได้ในครั้งเดียว</div>
       <div class="hf-bar"><input id="im-files" type="file" multiple accept="image/*,.zip,.json,application/zip"></div>
       <div class="hf-bar"><label><input id="im-skip" type="checkbox" checked> ข้ามสินค้าที่มีรูปอยู่แล้ว</label><label><input id="im-num" type="checkbox"> ลองเทียบ "เลขในชื่อไฟล์" กับเลขท้าย SKU (อาจเดาผิด — ตรวจก่อนอัปโหลด)</label></div>
       <div id="im-msg" class="sub"></div>
       <div class="hf-bar"><button class="hf-btn" id="im-cancel">ยกเลิก</button><button class="hf-btn pri" id="im-go">วิเคราะห์การจับคู่</button></div>`,
      (b) => {
        b.querySelector('#im-cancel').onclick = () => document.getElementById('im-dlg').remove();
        b.querySelector('#im-go').onclick = async () => {
          const fl = b.querySelector('#im-files').files, msg = b.querySelector('#im-msg');
          if (!fl.length) return window.showAlert?.('ยังไม่ได้เลือกไฟล์', 'เลือกรูป หรือไฟล์ .zip ก่อน', true);
          msg.textContent = '⏳ กำลังอ่านไฟล์…';
          try {
            const { files, jsonMap } = await collect(fl);
            if (!files.length) { msg.textContent = ''; return window.showAlert?.('ไม่พบรูปภาพ', 'ไม่มีไฟล์รูปในที่เลือก (รองรับ jpg, png, webp, gif, heic)', true); }
            stepReview(files, matchAll(files, { skipHas: b.querySelector('#im-skip').checked, num: b.querySelector('#im-num').checked }, jsonMap), { skipHas: b.querySelector('#im-skip').checked, num: b.querySelector('#im-num').checked }, jsonMap);
          } catch (e) { msg.textContent = ''; window.showAlert?.('อ่านไฟล์ไม่สำเร็จ', String((e && e.message) || e), true); }
        };
      });
  }

  function stepReview(files, items, opts, jsonMap) {
    const by = (s) => items.filter(i => i.status === s), ok = by('ok'), amb = by('amb'), none = by('none'), dup = by('dup'), has = by('has');
    const ruleCount = {}; ok.forEach(i => ruleCount[i.rule] = (ruleCount[i.rule] || 0) + 1);
    const shown = ok.slice(0, 300), sample = (arr) => arr.slice(0, 12).map(i => esc(i.f.name)).join(', ') + (arr.length > 12 ? ' …' : '');
    frame('ผลการจับคู่ (' + files.length + ' รูป)',
      `<div class="hf-note ${ok.length ? 'ok' : 'bad'}">จับคู่ได้ <b>${ok.length}</b> • กำกวม (ตรงหลายสินค้า) <b>${amb.length}</b> • ไม่พบสินค้า <b>${none.length}</b> • รูปซ้ำสินค้าเดียวกัน <b>${dup.length}</b> • สินค้ามีรูปแล้ว <b>${has.length}</b><br>
        <span class="sub">วิธีที่จับคู่ได้: ${Object.entries(ruleCount).map(([k, v]) => `${RULE[k]} ${v}`).join(' • ') || '—'}</span></div>
       ${none.length ? `<div class="hf-note"><b>ไม่พบสินค้า ${none.length} รูป</b> ตัวอย่าง: ${sample(none)}<br>ตรวจว่าชื่อไฟล์ตรงกับ SKU/บาร์โค้ด/ชื่อสินค้าในระบบ หรือลองติ๊ก "เทียบเลขกับเลขท้าย SKU" แล้วกลับไปวิเคราะห์ใหม่ • <a href="#" id="im-csv-none">ดาวน์โหลดรายชื่อที่ไม่พบ (CSV)</a></div>` : ''}
       ${amb.length ? `<div class="hf-note"><b>กำกวม ${amb.length} รูป</b> (ตรงมากกว่า 1 สินค้า จึงไม่ผูกให้ — ตั้งชื่อไฟล์ให้ชัดขึ้น): ${sample(amb)}</div>` : ''}
       ${ok.length ? `<div class="hf-bar"><button class="hf-btn" id="im-all">เลือก/ยกเลิกทั้งหมดที่แสดง</button></div>
       <div class="hf-list">${shown.map((it, i) => `<label class="hf-row"><input type="checkbox" class="im-c" data-i="${i}" checked><div class="grow">${esc(it.f.name)} → <b>${esc(it.p.name)}</b><div class="sub">${RULE[it.rule]}</div></div></label>`).join('')}</div>
       ${ok.length > shown.length ? `<div class="sub" style="margin-top:6px">แสดง 300 รายการแรก (อีก ${ok.length - shown.length} รายการจะถูกอัปโหลดด้วย)</div>` : ''}` : ''}
       <div class="hf-bar"><button class="hf-btn" id="im-back">← เลือกไฟล์ใหม่</button><button class="hf-btn pri" id="im-up" ${ok.length ? '' : 'disabled'}>อัปโหลดและผูกรูป</button></div>`,
      (b) => {
        b.querySelector('#im-back').onclick = stepPick;
        const all = b.querySelector('#im-all'); if (all) all.onclick = () => { const bx = [...b.querySelectorAll('.im-c')], on = bx.some(x => !x.checked); bx.forEach(x => x.checked = on); };
        const csv = b.querySelector('#im-csv-none'); if (csv) csv.onclick = (e) => { e.preventDefault(); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeffไฟล์รูปที่ไม่พบสินค้า\n' + none.map(i => '"' + i.f.name.replace(/"/g, '""') + '"').join('\n')], { type: 'text/csv;charset=utf-8' })); a.download = 'unmatched-images.csv'; document.body.appendChild(a); a.click(); a.remove(); };
        b.querySelector('#im-up').onclick = () => {
          const off = new Set([...b.querySelectorAll('.im-c')].filter(x => !x.checked).map(x => +x.dataset.i));
          const todo = ok.filter((it, i) => !(i < shown.length && off.has(i)));
          if (!todo.length) return window.showAlert?.('ไม่มีรูปให้อัปโหลด', 'ติ๊กอย่างน้อย 1 รายการ', true);
          if (!confirm(`อัปโหลด ${todo.length} รูปแล้วผูกกับสินค้า?\n(ย่อรูปเป็นไม่เกิน 900px และแปลงเป็น JPEG ก่อนอัปโหลด)`)) return;
          stepUpload(todo);
        };
      });
  }

  async function stepUpload(todo) {
    const client = window.getSupabaseClient?.();
    if (!client || navigator.onLine === false) return window.showAlert?.('ต้องออนไลน์', 'การอัปโหลดรูปต้องเชื่อมต่อ Supabase', true);
    state.cancel = false; let done = 0, okN = 0; const fails = [];
    frame('กำลังอัปโหลดรูป…', `<p id="im-prog" style="font-weight:700">0 / ${todo.length}</p><div style="background:#e2e8f0;border-radius:999px;height:12px;overflow:hidden"><div id="im-bar" style="background:#4f46e5;height:12px;width:0%;transition:width .2s"></div></div><p class="sub" style="margin-top:8px">อย่าปิดหน้านี้หรือสลับแอปจนกว่าจะเสร็จ</p><div class="hf-bar"><button class="hf-btn warn" id="im-stop">หยุด</button></div>`,
      (b) => { b.querySelector('#im-stop').onclick = () => { state.cancel = true; b.querySelector('#im-stop').disabled = true; }; });
    const tick = () => { const pr = document.getElementById('im-prog'), bar = document.getElementById('im-bar'); if (pr) pr.textContent = `${done} / ${todo.length} (สำเร็จ ${okN})`; if (bar) bar.style.width = Math.round(done / todo.length * 100) + '%'; };
    let next = 0, since = 0;
    async function worker() {
      while (!state.cancel) {
        const i = next++; if (i >= todo.length) return; const it = todo[i];
        try {
          const blob = await toJpeg(await it.f.getBlob(), 900);
          const path = `product-${String(it.p.id).replace(/[^\w-]/g, '_')}-${Date.now()}-${i}.jpg`;
          const { error } = await client.storage.from('product-images').upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
          if (error) throw error;
          it.p.imageUrl = client.storage.from('product-images').getPublicUrl(path).data.publicUrl; okN++;
          if (++since >= 20) { since = 0; window.persist?.(); }
        } catch (e) { fails.push(it.f.name + ' — ' + ((e && e.message) || e)); }
        done++; tick();
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    window.persist?.(); try { await window.syncProductsToSupabase?.(true); } catch (e) { console.warn(e); }
    window.renderStockTable?.(); window.renderSaleHome?.();
    const cancelled = state.cancel && done < todo.length;
    const hint = fails.length && /bucket|not found|policy|row-level|mime|403|404/i.test(fails[0]) ? '<br><b>แนะนำ:</b> ตรวจว่ารัน SQL สร้าง bucket "product-images" และสิทธิ์ Storage แล้ว และบัญชีที่ล็อกอินเป็นพนักงาน/เจ้าของร้าน' : '';
    frame(cancelled ? 'หยุดการอัปโหลดแล้ว' : 'อัปโหลดเสร็จ',
      `<div class="hf-note ${fails.length ? '' : 'ok'}">ผูกรูปสำเร็จ <b>${okN}</b> จาก ${todo.length}${cancelled ? ` (หยุดที่ ${done})` : ''}${fails.length ? ` • ล้มเหลว <b>${fails.length}</b>` : ''}${hint}</div>
       ${fails.length ? `<div class="hf-list" style="padding:8px">${fails.slice(0, 40).map(esc).join('<br>')}</div>` : ''}
       <div class="hf-bar"><button class="hf-btn pri" id="im-done">ปิด</button>${(cancelled || fails.length) ? '<button class="hf-btn" id="im-again">ทำรายการที่เหลือ</button>' : ''}</div>`,
      (b) => { b.querySelector('#im-done').onclick = () => document.getElementById('im-dlg')?.remove(); const a = b.querySelector('#im-again'); if (a) a.onclick = stepPick; });
  }

  window.openImageMatcher = function () { stepPick(); };

  // ปุ่มทางลัดในหน้าต่างนำเข้ารูปแบบเดิม
  const origOpen = window.openBulkImageModal;
  if (typeof origOpen === 'function') {
    window.openBulkImageModal = function () {
      const r = origOpen.apply(this, arguments);
      try {
        const btn = document.getElementById('btn-start-bulk-image');
        if (btn && !document.getElementById('im-launch')) btn.parentNode.insertAdjacentHTML('beforebegin', '<div id="im-launch" style="margin:0 0 10px"><button class="hf-btn pri" style="width:100%" onclick="window.closeModal(\'modal-bulk-image\');window.openImageMatcher()">✨ จับคู่รูปอัตโนมัติ (ไม่ต้องใช้ไฟล์ JSON • รองรับ ZIP)</button></div>');
      } catch (e) { console.warn(e); }
      return r;
    };
  }
  window._im = { norm, buildIndex, matchOne, matchAll };   // สำหรับทดสอบ
})();
