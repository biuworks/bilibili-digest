const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../page-panel.js'), 'utf8');

function harness({ open = false, initialReply, layout = {} } = {}) {
  const nodes = [];
  const messages = [];
  const documentEvents = {};
  const windowEvents = {};
  let listener;
  let interval;
  const timers = new Map(); let timerId = 0;
  const browserWindow = { innerWidth: 1280, innerHeight: 900, addEventListener: (type, fn) => { windowEvents[type] = fn; } };
  const make = tag => {
    const node = { tag, style: {}, children: [], isConnected: false, events: {},
      attributes: {},
      setAttribute(key, value) { this.attributes[key] = value; },
      setPointerCapture(id) { this.capture = id; },
      hasPointerCapture(id) { return this.capture === id; },
      releasePointerCapture() { this.capture = null; },
      getBoundingClientRect() {
        const left = parseFloat(this.style.left) || 0, top = parseFloat(this.style.top) || 0;
        return {left, top, right:left+(parseFloat(this.style.width)||44), bottom:top+(parseFloat(this.style.height)||44)};
      },
      addEventListener(type, fn) { this.events[type] = fn; },
      appendChild(child) { this.children.push(child); child.isConnected = true; return child; },
      append(...children) { children.forEach(child => this.appendChild(child)); },
      attachShadow() { this.shadow = make('shadow'); return this.shadow; },
      remove() { this.isConnected = false; },
    };
    nodes.push(node);
    return node;
  };
  const document = { documentElement: make('html'), visibilityState: 'visible',
    createElement: make, getElementById: id => nodes.find(n => n.id === id && n.isConnected),
    addEventListener: (type, fn) => { documentEvents[type] = fn; },
  };
  let first = true;
  vm.runInNewContext(source, { document, console,
    window: browserWindow,
    setTimeout: fn => { const id=++timerId; timers.set(id,fn); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: fn => { interval = fn; },
    chrome: { runtime: {
      getURL: value => 'chrome-extension://test/' + value,
      onMessage: { addListener: fn => { listener = fn; } },
      sendMessage: async message => {
        messages.push(message);
        if (message.action === 'setPagePanelOpen') open = message.open;
        if (message.action === 'setPagePanelLayout') layout = { ...layout, ...message.layout, version: (layout.version || 0) + 1 };
        if (first && initialReply) { first = false; return initialReply; }
        return { success: true, open, layout };
      },
    } },
  });
  return { nodes, messages, document, documentEvents, windowEvents, browserWindow,
    collapse: () => { const callbacks=[...timers.values()]; timers.clear(); callbacks.forEach(fn=>fn()); },
    find: name => nodes.find(n=>n.className === name),
    broadcast(value) { open = value; listener({ action: 'pagePanelStateChanged', open }); },
    broadcastLayout(value) { layout = value; listener({action:'pagePanelLayoutChanged',layout}); },
    savedLayout: () => structuredClone(layout),
    host: () => document.getElementById('bili-digest-page-panel'),
    tick: () => interval(),
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('默认不插入面板；收到打开通知创建唯一扩展 iframe', async () => {
  const h = harness(); await flush(); assert.equal(h.host(), undefined);
  h.broadcast(true); const host = h.host(); assert.ok(host);
  h.broadcast(true); assert.equal(h.host(), host);
  const frames = h.nodes.filter(n => n.tag === 'iframe');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].src, 'chrome-extension://test/sidepanel.html?embedded=1');
});
test('打开状态在新页面恢复，切换可见性不销毁或重建 iframe', async () => {
  const h = harness({open:true}); await flush(); const host = h.host();
  h.document.visibilityState = 'hidden'; h.documentEvents.visibilitychange();
  assert.equal(h.host(), host);
  h.document.visibilityState = 'visible'; h.documentEvents.visibilitychange(); await flush();
  assert.equal(h.host(), host);
});
test('手动关闭写入关闭状态，切回页面、pageshow、自查均不弹出', async () => {
  const h = harness({open:true}); await flush();
  await h.nodes.find(n => n.className === 'close').events.click();
  assert.equal(h.host(), undefined);
  assert.ok(h.messages.some(m => m.action === 'setPagePanelOpen' && m.open === false));
  await h.windowEvents.pageshow(); h.documentEvents.visibilitychange(); h.tick(); await flush();
  assert.equal(h.host(), undefined);
  h.broadcast(true); assert.ok(h.host());
});
test('其他标签页的关闭通知移除本页面板，迟到的启动回复不能重开', async () => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const h = harness({ initialReply:pending });
  h.broadcast(true); assert.ok(h.host()); h.broadcast(false);
  resolve({success:true,open:true}); await flush();
  assert.equal(h.host(), undefined);
});
test('页面移除外壳后补回，但手动关闭后不补回', async () => {
  const h = harness({open:true}); await flush(); const old = h.host(); old.remove();
  h.tick(); assert.ok(h.host()); assert.notEqual(h.host(),old);
  h.broadcast(false); h.tick(); assert.equal(h.host(),undefined);
});

test('悬停展开、移出收起，iframe 不重建；跨过间隙进入面板不会收起',async()=>{
 const h=harness({open:true});await flush();
 const panel=h.find('panel'), bubble=h.find('bubble'), frame=h.nodes.find(n=>n.tag==='iframe');
 assert.equal(panel.hidden,true);
 bubble.events.pointerenter();assert.equal(panel.hidden,false);
 bubble.events.pointerleave();panel.events.pointerenter();h.collapse();
 assert.equal(panel.hidden,false);
 panel.events.pointerleave();h.collapse();assert.equal(panel.hidden,true);
 bubble.events.pointerenter();assert.equal(panel.hidden,false);
 assert.equal(h.nodes.filter(n=>n.tag==='iframe').length,1);
 assert.equal(h.nodes.find(n=>n.tag==='iframe'),frame);
});
test('固定后离开仍展开，取消固定后恢复自动收起',async()=>{
 const h=harness({open:true});await flush();
 h.find('bubble').events.pointerenter();h.find('pin').events.click();
 h.find('bubble').events.pointerleave();h.collapse();
 assert.equal(h.find('panel').hidden,false);
 assert.equal(h.find('pin').attributes['aria-pressed'],'true');
 h.find('pin').events.click();h.collapse();assert.equal(h.find('panel').hidden,true);
});
const pointer=(node,x,y)=>({button:0,pointerId:1,clientX:x,clientY:y,target:node,preventDefault(){}});
test('固定状态标题栏仍可拖动，拖动时屏蔽 iframe，结束恢复',async()=>{
 const h=harness({open:true});await flush();h.find('bubble').events.pointerenter();h.find('pin').events.click();
 const bar=h.find('bar'), panel=h.find('panel'), frame=h.nodes.find(n=>n.tag==='iframe');
 const left=parseFloat(panel.style.left),top=parseFloat(panel.style.top);
 bar.events.pointerdown(pointer(bar,900,100));assert.equal(frame.style.pointerEvents,'none');
 bar.events.pointermove(pointer(bar,800,140));
 assert.equal(parseFloat(panel.style.left),left-100);assert.equal(parseFloat(panel.style.top),top+40);
 bar.events.pointerup(pointer(bar,800,140));assert.equal(frame.style.pointerEvents,'auto');
 h.collapse();assert.equal(panel.hidden,false);
});
test('悬浮按钮可拖到页面边缘，展开面板仍保持在可见区域',async()=>{
 const h=harness({open:true});await flush();const b=h.find('bubble');
 b.events.pointerdown(pointer(b,1220,30));b.events.pointermove(pointer(b,5000,5000));b.events.pointerup(pointer(b,5000,5000));
 assert.equal(parseFloat(b.style.left),1228);assert.equal(parseFloat(b.style.top),848);
 b.events.pointerenter();const p=h.find('panel').getBoundingClientRect();
 assert.ok(p.right<=1272&&p.bottom<=892);
});
test('四角缩放有最小尺寸限制，窗口缩小时面板不会丢到屏幕外',async()=>{
 const h=harness({open:true});await flush();h.find('bubble').events.pointerenter();h.find('pin').events.click();
 const handle=h.find('handle se'), panel=h.find('panel');
 handle.events.pointerdown(pointer(handle,1200,700));handle.events.pointermove(pointer(handle,0,0));handle.events.pointerup(pointer(handle,0,0));
 assert.equal(parseFloat(panel.style.width),320);assert.equal(parseFloat(panel.style.height),240);
 h.browserWindow.innerWidth=300;h.browserWindow.innerHeight=220;h.windowEvents.resize();
 const r=panel.getBoundingClientRect();assert.ok(r.left>=0&&r.top>=0&&r.right<=300&&r.bottom<=220);
});
test('点固定/关闭按钮不会触发标题栏拖动',async()=>{
 const h=harness({open:true});await flush();const bar=h.find('bar');
 const event=pointer(bar,0,0);event.target={closest:()=>({})};bar.events.pointerdown(event);
 assert.equal(bar.capture,undefined);
});

test('刷新和新标签页恢复位置、尺寸、按钮位置与固定展开状态',async()=>{
 const layout={x:100,y:140,width:500,height:600,bubbleX:110,bubbleY:70,pinned:true,version:3};
 const h=harness({open:true,layout});await flush();
 assert.equal(h.find('panel').style.left,'100px');assert.equal(h.find('panel').style.width,'500px');
 assert.equal(h.find('panel').style.height,'600px');assert.equal(h.find('bubble').style.top,'70px');
 assert.equal(h.find('pin').attributes['aria-pressed'],'true');assert.equal(h.find('panel').hidden,false);
 h.find('panel').events.pointerleave();h.collapse();assert.equal(h.find('panel').hidden,false);
});
test('拖动结束才保存几何布局，固定按钮只保存固定状态',async()=>{
 const h=harness({open:true});await flush();const bar=h.find('bar');
 bar.events.pointerdown(pointer(bar,900,100));bar.events.pointermove(pointer(bar,750,140));
 assert.equal(h.messages.filter(m=>m.action==='setPagePanelLayout').length,0);
 bar.events.pointerup(pointer(bar,750,140));await flush();
 const saved=h.savedLayout();assert.equal(saved.x,666);assert.equal(saved.y,130);
 h.find('pin').events.click();await flush();assert.equal(h.savedLayout().pinned,true);
 assert.deepEqual(structuredClone(h.messages.filter(m=>m.action==='setPagePanelLayout').at(-1).layout),{pinned:true});
 const restored=harness({open:true,layout:h.savedLayout()});await flush();
 assert.equal(restored.find('panel').style.left,'666px');assert.equal(restored.find('panel').hidden,false);
});
test('跨标签布局广播立即同步且不重建 iframe，旧版本不能覆盖新布局',async()=>{
 const h=harness({open:true});await flush();const frame=h.nodes.find(n=>n.tag==='iframe');
 h.broadcastLayout({x:50,y:100,width:550,height:500,pinned:true,version:4});
 assert.equal(h.find('panel').style.left,'50px');assert.equal(h.find('panel').hidden,false);
 h.broadcastLayout({x:400,pinned:false,version:3});assert.equal(h.find('panel').style.left,'50px');
 assert.equal(h.nodes.filter(n=>n.tag==='iframe').length,1);assert.equal(h.nodes.find(n=>n.tag==='iframe'),frame);
 h.broadcastLayout({pinned:false,version:5});assert.equal(h.find('panel').hidden,true);
});
test('小窗口只限制显示，不回写布局；关闭后仍保存固定偏好',async()=>{
 const layout={x:800,y:200,width:450,height:650,bubbleX:1100,bubbleY:100,pinned:true,version:2};
 const h=harness({open:true,layout});await flush();
 h.browserWindow.innerWidth=400;h.browserWindow.innerHeight=300;h.windowEvents.resize();
 assert.equal(h.messages.filter(m=>m.action==='setPagePanelLayout').length,0);
 assert.deepEqual(h.savedLayout(),layout);
 await h.find('close').events.click();await h.windowEvents.pageshow();
 assert.equal(h.host(),undefined);assert.equal(h.savedLayout().pinned,true);
 h.broadcast(true);assert.ok(h.host());
 assert.equal(h.nodes.filter(n=>n.className==='panel').at(-1).hidden,false);
});

test('启动期间收到新布局不会阻止打开恢复，旧启动布局不能覆盖广播',async()=>{
 let resolve;const initialReply=new Promise(r=>resolve=r);
 const h=harness({initialReply});
 h.broadcastLayout({x:80,y:100,width:500,height:500,pinned:true,version:8});
 resolve({success:true,open:true,layout:{x:400,pinned:false,version:7}});await flush();
 assert.ok(h.host());assert.equal(h.find('panel').style.left,'80px');assert.equal(h.find('panel').hidden,false);
});

test('恢复默认布局重置所有几何字段和固定状态，保存后刷新沿用',async()=>{
 const h=harness({open:true,layout:{x:40,y:50,width:700,height:750,bubbleX:80,bubbleY:100,pinned:true,version:3}});
 await flush();const frame=h.nodes.find(n=>n.tag==='iframe');
 await h.find('reset').events.click();
 assert.deepEqual(h.savedLayout(),{x:816,y:90,width:440,height:620,bubbleX:1216,bubbleY:24,pinned:false,version:4});
 assert.equal(h.find('panel').style.width,'440px');assert.equal(h.find('panel').style.left,'816px');
 assert.equal(h.find('pin').attributes['aria-pressed'],'false');assert.equal(h.find('reset').disabled,false);
 assert.equal(h.nodes.find(n=>n.tag==='iframe'),frame);
 assert.ok(!h.messages.some(m=>m.action==='setPagePanelOpen'));
 const refreshed=harness({open:true,layout:h.savedLayout()});await flush();
 assert.equal(refreshed.find('panel').style.height,'620px');assert.equal(refreshed.find('panel').hidden,true);
});
test('默认布局同步到其他标签页并适应小窗口，不改动关闭状态',async()=>{
 const layout={x:80,y:80,width:600,height:700,bubbleX:80,bubbleY:20,pinned:true,version:6};
 const a=harness({open:true,layout}),b=harness({open:true,layout}),closed=harness({open:false,layout});
 await flush();b.browserWindow.innerWidth=400;b.browserWindow.innerHeight=300;
 await a.find('reset').events.click();b.broadcastLayout(a.savedLayout());closed.broadcastLayout(a.savedLayout());
 assert.equal(b.find('pin').attributes['aria-pressed'],'false');assert.equal(b.find('panel').hidden,true);
 const rect=b.find('panel').getBoundingClientRect();assert.ok(rect.right<=400&&rect.bottom<=300);
 assert.equal(closed.host(),undefined);assert.deepEqual(b.savedLayout(),a.savedLayout());
});
