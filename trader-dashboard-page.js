export function traderDashboardPageHTML(content) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>Jarvis Trader</title>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="theme-color" content="#f3f4f6">
<style>
  *{box-sizing:border-box}
  html,body{margin:0;min-height:100%;background:#f3f4f6;color:#23242a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
  body{height:100dvh;padding:14px;overflow:hidden}
  button,select,textarea{font:inherit}
  a{color:inherit;text-decoration:none}
  .positive{color:#087d3b!important}.negative{color:#cf3e36!important}
  .trader-app{max-width:1440px;margin:0 auto}
  .trader-header{height:48px;display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
  .trader-header select{min-width:220px;max-width:55%;padding:9px 34px 9px 11px;border:1px solid #d9dce2;border-radius:10px;background:#fff;color:#23242a;font-size:13px;font-weight:700}
  .header-right{display:flex;align-items:center;gap:7px}
  .market-dot,.automation-mode{padding:5px 8px;border-radius:999px;font-size:9px;font-weight:900;letter-spacing:.06em;background:#eceef1;color:#6b7280}
  .market-dot.is-open{background:#e7f8ed;color:#067a2f}.automation-mode{background:#f0ecff;color:#5c43d5}
  .desktop-chat-trigger{border:1px solid #d9dce2;border-radius:9px;background:#fff;color:#5c43d5;padding:7px 10px;font-weight:800;cursor:pointer}
  .panel-grid{height:calc(100dvh - 88px);display:grid;grid-template-columns:1fr 1fr;grid-template-rows:repeat(2,minmax(0,1fr));gap:12px}
  .dashboard-panel{min-width:0;min-height:0;display:flex;flex-direction:column;background:#fff;border:1px solid #e0e3e8;border-radius:15px;padding:15px;box-shadow:0 5px 22px rgba(35,36,42,.05);overflow:hidden}
  .panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px}
  .panel-head h2{font-size:15px;letter-spacing:-.01em;margin:0;color:#23242a}.panel-head span{font-size:9px;color:#8a909b}
  .chart-legend{display:flex;gap:18px;margin:0 0 4px;font-size:11px;color:#646672}.chart-legend span{display:flex;align-items:center;gap:5px}.chart-legend i{width:8px;height:8px;border-radius:50%}
  .merged-chart{width:100%;height:100%;min-height:210px;display:block;overflow:visible}.chart-line{fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}.chart-grid{stroke:#e9ebef;stroke-width:1}.chart-baseline{stroke:#b9bdc6;stroke-width:1;stroke-dasharray:4 4}.chart-axis{fill:#9ca1ac;font-size:9px}.chart-empty{flex:1;display:flex;align-items:center;justify-content:center;color:#9ca1ac;font-size:11px}
  .account-strip{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:4px}.account-strip>div{padding:9px 10px;background:#f6f7f9;border-radius:9px}.account-strip span{display:block;font-size:8px;color:#8a909b;text-transform:uppercase;letter-spacing:.05em}.account-strip b{display:block;font-size:15px;margin-top:2px}
  .bounded-list{flex:1;min-height:0;display:grid;align-content:start;gap:7px;overflow-y:auto;padding-right:2px;overscroll-behavior:contain}
  .compact-trade,.compact-idea{display:block;color:#30313a;padding:11px;border:1px solid #e5e7eb;border-radius:10px;background:#fff}.compact-trade:hover,.compact-idea:hover{border-color:#bbb0ef}
  .compact-trade-head,.compact-idea>div{display:flex;align-items:center;gap:9px}.compact-trade-head{justify-content:space-between}.compact-trade-head b,.compact-idea b{font-size:14px}.compact-meta{display:flex;gap:10px;flex-wrap:wrap;margin-top:5px;font-size:9px;color:#6b7280}.authority-line{margin-top:7px;color:#5c43d5;font-size:8px;font-weight:900}.compact-trade p,.compact-idea p{font-size:10px;line-height:1.4;color:#666976;margin:7px 0 0}
  .compact-idea>div:first-child span{font-size:10px;color:#686b77}.compact-idea>div:nth-child(2){margin-top:4px;font-size:9px;color:#6b7280}.idea-state{margin-left:auto;padding:3px 6px;border-radius:999px;font-size:8px!important;font-weight:900}.idea-state.ready{background:#e7f8ed;color:#067a2f!important}.idea-state.blocked{background:#fff4d9;color:#8a5a00!important}.idea-state.watch{background:#eef0f3;color:#676a75!important}
  .panel-empty{flex:1;display:flex;align-items:center;justify-content:center;color:#9ca1ac;font-size:11px}
  .mobile-dock{display:none}
  .chat-window{position:fixed;z-index:100;right:18px;bottom:18px;width:min(520px,calc(100vw - 36px));height:min(720px,calc(100dvh - 36px));display:flex;flex-direction:column;background:#fff;border:1px solid #dfe2e7;border-radius:18px;box-shadow:0 25px 80px rgba(20,22,28,.22);opacity:0;pointer-events:none;transform:translateY(18px) scale(.98);transition:.18s ease;overflow:hidden}
  .chat-window.open{opacity:1;pointer-events:auto;transform:none}.chat-window-head{height:52px;flex:0 0 52px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;border-bottom:1px solid #e7e9ed}.chat-window-head b{font-size:15px}.chat-window-head button{border:0;background:none;color:#5c43d5;font-weight:800;cursor:pointer}
  .chat-history{flex:1;min-height:0;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:11px;overscroll-behavior:contain}.chat-row{max-width:86%}.chat-row.from-user{align-self:flex-end}.chat-label{font-size:8px;color:#9ba0aa;margin:0 6px 3px}.from-user .chat-label{text-align:right}.chat-text{padding:9px 11px;border-radius:14px 14px 14px 4px;background:#f3f1fb;color:#333541;font-size:12px;line-height:1.5}.from-user .chat-text{background:#6a4df4;color:#fff;border-radius:14px 14px 4px 14px}
  .chat-compose{display:flex;gap:7px;align-items:flex-end;padding:9px max(10px,env(safe-area-inset-right)) calc(9px + env(safe-area-inset-bottom));border-top:1px solid #e7e9ed;background:#fff}.chat-compose textarea{flex:1;min-height:40px;max-height:110px;resize:none;border:1px solid #d9dce2;border-radius:13px;padding:10px 11px;outline:0;background:#f8f9fa;color:#23242a;font:15px/1.35 inherit}.chat-compose button{width:40px;height:40px;border:0;border-radius:12px;background:#6a4df4;color:#fff;font-size:19px;font-weight:900}.chat-readonly{padding:12px;text-align:center;color:#8a909b}

  @media(max-width:600px){
    body{height:100dvh;padding:0;overflow:hidden;background:#fff}
    .trader-app{height:100dvh;display:flex;flex-direction:column;padding-top:env(safe-area-inset-top)}
    .trader-header{height:54px;flex:0 0 54px;margin:0;padding:7px 10px;border-bottom:1px solid #e6e8ec;background:#fff}
    .trader-header select{min-width:0;max-width:58%;padding:8px 28px 8px 9px;font-size:16px}
    .header-right{gap:4px}.market-dot,.automation-mode{padding:4px 6px;font-size:7px}.desktop-chat-trigger{display:none}
    .panel-grid{height:auto;display:block;flex:1;min-height:0;padding:8px 8px calc(62px + env(safe-area-inset-bottom));background:#f3f4f6}
    .dashboard-panel{display:none;height:100%;min-height:0;border-radius:12px;padding:12px;box-shadow:none}
    .dashboard-panel.active{display:flex}
    .merged-chart{height:100%;min-height:210px}.account-strip{grid-template-columns:repeat(3,1fr)}.account-strip>div{padding:8px}.account-strip b{font-size:14px}
    .bounded-list{padding-bottom:2px}.compact-trade,.compact-idea{padding:10px}
    .mobile-dock{display:grid;grid-template-columns:repeat(5,1fr);position:fixed;z-index:50;left:0;right:0;bottom:0;padding:5px 4px calc(5px + env(safe-area-inset-bottom));background:#fffffff2;border-top:1px solid #dfe2e7;backdrop-filter:blur(18px)}
    .mobile-dock button{border:0;background:none;display:flex;flex-direction:column;align-items:center;gap:2px;color:#6c6f7a;font-size:8px;font-weight:800;padding:2px}.mobile-dock button.active{color:#5c43d5}.mobile-dock button span{display:flex;align-items:center;justify-content:center;min-width:25px;height:22px;padding:0 4px;border-radius:8px;background:#f0ecff;color:#5c43d5;font-size:9px;font-weight:900}
    .chat-window{inset:0;width:100%;height:100dvh;border:0;border-radius:0;transform:translateY(100%);opacity:1}.chat-window.open{transform:none}.chat-window-head{padding-top:env(safe-area-inset-top);height:calc(52px + env(safe-area-inset-top));flex-basis:calc(52px + env(safe-area-inset-top))}
  }
</style></head><body>
${content}
<script>
(function initTraderWorkspace() {
  const input = document.getElementById('jarvis-input');
  const chat = document.getElementById('chat-window');
  const history = document.getElementById('chat-history');
  const accountSelect = document.getElementById('mobile-account-select');
  const panelButtons = [...document.querySelectorAll('[data-panel-target]')];
  const panels = [...document.querySelectorAll('[data-panel]')];

  function showPanel(name) {
    if (!panels.some(panel => panel.dataset.panel === name)) name = 'market';
    panels.forEach(panel => panel.classList.toggle('active', panel.dataset.panel === name));
    panelButtons.forEach(button => button.classList.toggle('active', button.dataset.panelTarget === name));
    try { sessionStorage.setItem('traderPanel', name); } catch {}
  }
  let initialPanel = 'market';
  try { initialPanel = sessionStorage.getItem('traderPanel') || 'market'; } catch {}
  showPanel(initialPanel);
  panelButtons.forEach(button => button.addEventListener('click', () => showPanel(button.dataset.panelTarget)));

  if (accountSelect) accountSelect.addEventListener('change', () => {
    location.href = '/?a=' + accountSelect.value;
  });

  function openChat() {
    if (!chat) return;
    chat.classList.add('open');
    chat.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
      if (history) history.scrollTop = history.scrollHeight;
      if (input) input.focus();
    });
  }
  function closeChat() {
    if (!chat) return;
    chat.classList.remove('open');
    chat.setAttribute('aria-hidden', 'true');
  }
  document.querySelectorAll('[data-open-chat]').forEach(button => button.addEventListener('click', openChat));
  document.querySelectorAll('[data-close-chat]').forEach(button => button.addEventListener('click', closeChat));

  if (input) {
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(110, input.scrollHeight) + 'px';
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (input.value.trim()) input.form.requestSubmit();
      }
    });
  }
  if (history) history.scrollTop = history.scrollHeight;
  setInterval(() => {
    if (document.visibilityState !== 'visible' || chat?.classList.contains('open')) return;
    if (input && (document.activeElement === input || input.value.trim())) return;
    location.reload();
  }, 60_000);
})();
</script></body></html>`;
}
