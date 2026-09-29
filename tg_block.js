/* ================= Telegram Mini App ================= */
/* BOT_NAME объявлен в базовом файле (сборщик подставляет имя бота) */
const API_BASE=((typeof window.MONEYFORUP_API==='string'?window.MONEYFORUP_API:(typeof window.MATHPLAY_API==='string'?window.MATHPLAY_API:''))||'');   // ← URL бэкенда, '' = демо-режим
const TG=(window.Telegram&&window.Telegram.WebApp)?window.Telegram.WebApp:null;
const IS_TG=!!(TG&&TG.initData);
const TGU=(IS_TG&&TG.initDataUnsafe&&TG.initDataUnsafe.user)?TG.initDataUnsafe.user:null;
const TGSTART=(IS_TG&&TG.initDataUnsafe&&TG.initDataUnsafe.start_param)?TG.initDataUnsafe.start_param:'';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function tgHaptic(kind){
  try{const h=TG&&TG.HapticFeedback;if(!h)return;
    if(kind==='win')h.notificationOccurred('success');
    else if(kind==='lose')h.notificationOccurred('error');
    else h.impactOccurred(kind||'light');
  }catch(e){}
}
async function tgCall(path,body){
  const r=await fetch(API_BASE+path,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(Object.assign({initData:TG.initData},body||{}))});
  return r.json();
}
function tgApplyServer(d){
  if(!d)return;
  if(typeof d.tokens==='number'){S.balance=d.tokens;S.tgBalance=d.tokens;}
  if(typeof d.staked==='number')S.stake={amount:d.staked,since:Date.now(),accruedBase:d.accrued||0};
  if(d.refCode){S.refCode=String(d.refCode);S.refServer=true;}
  if(typeof d.refInvited==='number')S.refInvited=d.refInvited;
  if(typeof d.refEarned==='number')S.refEarned=d.refEarned;
  if(d.termsAt){S.termsAt=d.termsAt;}
  save();syncUI();paySync();
}
async function tgLoadBalance(){
  if(!IS_TG||!API_BASE)return;
  try{tgApplyServer(await tgCall('/api/balance',{}))}catch(e){}
}
async function tgRegister(){
  if(!IS_TG||!API_BASE)return;
  try{tgApplyServer(await tgCall('/api/register',{startParam:TGSTART,termsAcceptedAt:S.termsAt||0}))}catch(e){}
}
/* реальные платежи: Stars, CryptoBot, заявка по СБП */
if(IS_TG&&API_BASE){
  payProvider=async (rub,tk,methodId,msg)=>{
    /* 0 — карта/СБП, 1 — Telegram Stars, 2 — CryptoBot, 3 — промокод */
    if(methodId===4){
      msg.className='result';msg.innerHTML='Промокоды активируются администратором: отправьте код боту командой /promo.';
      return 'promo';
    }
    if(methodId===2){
      msg.className='result';msg.textContent='Создаём счёт в CryptoBot…';
      const d=await tgCall('/api/crypto-invoice',{rub,tokens:tk,termsAcceptedAt:S.termsAt});
      if(!d||!d.pay_url)throw new Error((d&&d.error)||'сервер не вернул ссылку CryptoBot');
      try{(TG.openLink?TG.openLink(d.pay_url):window.open(d.pay_url,'_blank','noopener'))}catch(e){}
      msg.innerHTML='Счёт CryptoBot открыт на '+fmt(tk)+' ⬦. Ждём подтверждения платежа…';
      for(let i=0;i<40;i++){
        await sleep(3000);
        const st=await tgCall('/api/check-crypto',{invoice_id:d.invoice_id});
        if(st&&st.paid){
          await tgLoadBalance();
          msg.className='result good';
          msg.innerHTML='Оплачено криптой: зачислено <b>'+fmt(st.tokens||d.tokens)+' ⬦</b>';
          tgHaptic('win');
          return 'paid';
        }
      }
      msg.className='result';
      msg.innerHTML='Платёж пока не подтверждён. Баланс обновится автоматически после оплаты.';
      return 'pending';
    }
    if(methodId===0){
      /* Platega: карта или СБП, плательщик выбирает способ на странице оплаты */
      msg.className='result';msg.textContent='Создаём платёжную ссылку…';
      const d=await tgCall('/api/platega-invoice',{rub,tokens:tk,termsAcceptedAt:S.termsAt});
      if(d&&d.pay_url){
        try{(TG.openLink?TG.openLink(d.pay_url):window.open(d.pay_url,'_blank','noopener'))}catch(e){}
        msg.className='result';
        msg.innerHTML='Открыта оплата на '+rub+' ₽ ('+fmt(d.tokens||tk)+' ⬦).<br>После оплаты токены зачислятся автоматически.';
        for(let i=0;i<40;i++){
          await sleep(3000);
          const st=await tgCall('/api/check-platega',{invoice_id:d.invoice_id});
          if(st&&st.paid){
            await tgLoadBalance();
            msg.className='result good';
            msg.innerHTML='Оплачено: зачислено <b>'+fmt(st.tokens||d.tokens||tk)+' ⬦</b>';
            tgHaptic('win');
            return 'paid';
          }
        }
        msg.className='result';
        msg.innerHTML='Платёж пока не подтверждён. Баланс обновится автоматически после оплаты.';
        return 'pending';
      }
      /* фолбэк: ручная заявка, если Platega не настроена или недоступна */
      if(d&&d.error)msg.textContent='Платёжный сервис недоступен, создаём заявку вручную…';
      const o=await tgCall('/api/order-sbp',{rub,termsAcceptedAt:S.termsAt});
      if(!o||!o.order_id)throw new Error((o&&o.error)||'не удалось создать заявку');
      msg.className='result';
      msg.innerHTML='Заявка <b>№'+o.order_id+'</b> на '+rub+' ₽ ('+fmt(o.tokens)+' ⬦) создана.<br>Переведите по СБП и дождитесь подтверждения — токены зачислятся автоматически.';
      return 'sbp';
    }
    if(methodId===3){
      /* Heleket: крипта (USDT, BTC, ETH), ссылка на оплату + опрос статуса */
      msg.className='result';msg.textContent='Создаём счёт в Heleket…';
      const d=await tgCall('/api/heleket-invoice',{rub,tokens:tk,termsAcceptedAt:S.termsAt});
      if(!d||!d.pay_url)throw new Error((d&&d.error)||'сервер не вернул ссылку Heleket');
      try{(TG.openLink?TG.openLink(d.pay_url):window.open(d.pay_url,'_blank','noopener'))}catch(e){}
      msg.className='result';
      msg.innerHTML='Счёт Heleket открыт на '+fmt(d.tokens||tk)+' ⬦. Ждём подтверждения платежа…';
      for(let i=0;i<40;i++){
        await sleep(3000);
        const st=await tgCall('/api/check-heleket',{invoice_id:d.invoice_id});
        if(st&&st.paid){
          await tgLoadBalance();
          msg.className='result good';
          msg.innerHTML='Оплачено криптой: зачислено <b>'+fmt(st.tokens||d.tokens||tk)+' ⬦</b>';
          tgHaptic('win');
          return 'paid';
        }
      }
      msg.className='result';
      msg.innerHTML='Платёж пока не подтверждён. Баланс обновится автоматически после оплаты.';
      return 'pending';
    }
    /* Telegram Stars */
    msg.className='result';msg.textContent='Создаём счёт в Telegram…';
    const d=await tgCall('/api/invoice',{rub,tokens:tk,termsAcceptedAt:S.termsAt});
    if(!d||!d.invoice_link)throw new Error((d&&d.error)||'сервер не вернул ссылку на оплату');
    await new Promise(resolve=>{
      TG.openInvoice(d.invoice_link,async st=>{
        if(st==='paid'){
          await tgLoadBalance();
          msg.className='result good';
          msg.innerHTML='Оплачено: зачислено <b>'+fmt(d.tokens||tk)+' ⬦</b>';
          tgHaptic('win');
        }else{
          msg.className='result bad';
          msg.textContent=st==='cancelled'?'Оплата отменена':'Платёж не прошёл';
          tgHaptic('lose');
        }
        resolve();
      });
    });
    return 'stars';
  };
}
function tgInit(){
  if(!TG)return;
  try{
    TG.ready();TG.expand();
    TG.disableVerticalSwipes&&TG.disableVerticalSwipes();
    TG.setHeaderColor&&TG.setHeaderColor('#161b28');
    TG.setBackgroundColor&&TG.setBackgroundColor('#161b28');
    const safe=(TG.contentSafeAreaInset&&TG.contentSafeAreaInset.bottom)||0;
    if(safe)document.documentElement.style.setProperty('--tgSafe',safe+'px');
    TG.BackButton&&TG.BackButton.onClick(()=>screen('games'));
  }catch(e){}
  if(TGU){
    ensureRefCode();                       // локальный уникальный код; сервер вернёт канонический в /api/register
    save();syncUI();                       // имя и аватар профиля заполняет база: @username из initDataUnsafe
  }
  const share=q('#tgShare'),info=q('#tgRefInfo');
  if(info)info.textContent=TGSTART?('Вас пригласил пользователь '+TGSTART+' · за его пополнения он получает 15 %'):'';
  if(share)share.onclick=()=>{
    const link='https://t.me/share/url?url='+encodeURIComponent(refLinkFor(ensureRefCode()))
      +'&text='+encodeURIComponent('MoneyForUp — математические игры. Держи 1000 токенов на старт');
    try{(IS_TG&&TG.openTelegramLink)?TG.openTelegramLink(link):window.open(link,'_blank','noopener')}catch(e){}
  };
  window.__tgSendTerms=()=>{if(IS_TG&&API_BASE)tgCall('/api/terms',{}).then(tgLoadBalance).catch(()=>{})};
}
/* ===================================================== */
