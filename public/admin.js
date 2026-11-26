let passcode='';
const $=selector=>document.querySelector(selector);
const message=(text,error=false)=>{const el=$('#admin-message');el.textContent=text;el.dataset.error=String(error);};
function lock(){passcode='';$('#admin-key').value='';$('#coin-mint').value='';$('#service-status').replaceChildren();$('#settings-panel').hidden=true;$('#login-panel').hidden=false;}
async function request(path,options={}){
 const response=await fetch(path,{...options,headers:{Authorization:`Bearer ${passcode}`,...(options.body?{'Content-Type':'application/json'}:{})},signal:AbortSignal.timeout(15000)});
 const data=await response.json();if(!response.ok){if(response.status===401)lock();throw new Error(response.status===401?'Access denied. Check the server’s ADMIN_PASSCODE.':data.error||'Request failed.');}return data;
}
async function refresh(){
 const [config,status]=await Promise.all([request('/admin/config'),request('/admin/status')]);
 $('#coin-mint').value=config.mint||'';$('#coin-mint').disabled=config.locked;$('#save-mint').disabled=config.locked;$('#mint-lock').hidden=!config.locked;
 const rows=[['Execution',config.execution==='live'?'Live':'Observation only'],['Worker',status.heartbeat&&Date.now()/1000-Number(status.heartbeat)<120?'Running':'Not connected'],['Automatic execution',status.paused?'Paused':'Not paused'],['RPC',config.rpcConfigured?'Configured':'Not configured'],['Creator wallet',config.creatorConfigured?'Configured':'Not configured'],['Launch time',config.startConfigured?'Configured':'Not configured'],['Nested fee wallet',config.nestedFeeWallet||'Not configured']];
 const list=$('#service-status');list.replaceChildren();for(const [name,value]of rows){const row=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=name;dd.textContent=value;row.append(dt,dd);list.append(row);}
 $('#login-panel').hidden=true;$('#settings-panel').hidden=false;
}
$('#login-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;passcode=$('#admin-key').value.trim();message('Checking access…');try{await refresh();$('#admin-key').value='';message('Admin unlocked.');}catch(error){lock();message(error.message,true);}finally{button.disabled=false;}});
$('#mint-form').addEventListener('submit',async event=>{event.preventDefault();const button=$('#save-mint');button.disabled=true;message('Saving Coin mint…');try{const result=await request('/admin/config',{method:'POST',body:JSON.stringify({mint:$('#coin-mint').value.trim()})});await refresh();message(result.message);}catch(error){message(error.message,true);button.disabled=$('#coin-mint').disabled;}});
$('#refresh-status').addEventListener('click',async()=>{try{await refresh();message('Status refreshed.');}catch(error){message(error.message,true);}});
$('#logout').addEventListener('click',()=>{lock();message('Admin locked.');});
