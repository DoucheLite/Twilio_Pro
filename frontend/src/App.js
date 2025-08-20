import React, { useEffect, useRef, useState } from "react";
class ErrorBoundary extends React.Component { constructor(p){ super(p); this.state={hasError:false,error:null}; } static getDerivedStateFromError(e){return{hasError:true,error:e}} componentDidCatch(e,i){console.error("UI Error:",e,i)} render(){ return this.state.hasError? (<div className="p-4 m-4 rounded border border-red-300 bg-red-50 text-red-700"><h2 className="font-semibold mb-2">Something went wrong.</h2><pre className="text-xs whitespace-pre-wrap">{String(this.state.error)}</pre></div>): this.props.children; } }
const LS={contacts:"twilio_pro_contacts",history:"twilio_pro_history"};
const useLocal=(k,i)=>{ const [v,s]=useState(()=>{try{const r=localStorage.getItem(k);return r?JSON.parse(r):i}catch{return i}}); useEffect(()=>{try{localStorage.setItem(k,JSON.stringify(v))}catch{}},[k,v]); return [v,s]; };
const norm=(t)=>{ if(!t) return ""; const c=t.replace(/[^\d+]/g,""); const plus=c.startsWith("+")?"+":""; const d=c.replace(/\D/g,""); return plus+d; };
const fmt=(t)=>{ const r=norm(t); if(r.startsWith("+")||r.length<=3) return r; const d=r.replace(/\D/g,""); if(d.length===10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`; if(d.length>6) return `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`; if(d.length>3) return `${d.slice(0,3)}-${d.slice(3)}`; return d; };
export default function App(){
  const [devStat,setDevStat]=useState("offline");
  const [callStat,setCallStat]=useState("idle");
  const [err,setErr]=useState("");
  const [id,setId]=useState("");
  const [num,setNum]=useState("");
  const [contacts,setContacts]=useLocal(LS.contacts,[]);
  const [hist,setHist]=useLocal(LS.history,[]);
  const [recordings,setRecordings]=useState([]);
  const [transcriptions,setTranscriptions]=useState([]);
  const [isRecording,setIsRecording]=useState(false);
  const [showRecordings,setShowRecordings]=useState(false);
  const [showTranscriptions,setShowTranscriptions]=useState(false);
  const [transcriptionSearch,setTranscriptionSearch]=useState("");
  const [conversationContacts,setConversationContacts]=useState([]);
  const [selectedContact,setSelectedContact]=useState(null);
  const [contactContext,setContactContext]=useState(null);
  const [showContactDetails,setShowContactDetails]=useState(false);
  const deviceRef=useRef(null); const actRef=useRef(null); const incRef=useRef(null); const tRef=useRef(null);
  useEffect(()=>{ let mounted=true; (async()=>{ try{
      if(!window.Twilio||!window.Twilio.Device){ setErr("Twilio SDK not loaded. Check index.html."); return; }
      const r=await fetch('http://localhost:5001/api/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})}); const j=await r.json(); if(!r.ok) throw new Error(j?.error||'Failed to fetch token'); if(!mounted) return; setId(j.identity||'');
      const dev=new window.Twilio.Device(j.token,{logLevel:process.env.NODE_ENV==='development'?'warn':'error',codecPreferences:['opus','pcmu'],enableRingingState:true}); deviceRef.current=dev; setDevStat('registering');
      const onReg=()=>setDevStat('ready'); const onUnreg=()=>setDevStat('offline'); const onErr=(e)=>{console.error('Device error',e); setErr(e?.message||String(e)); setDevStat('error')}; const onInc=(c)=>{incRef.current=c; setCallStat('incoming'); c.on('cancel',()=>{ if(incRef.current===c) incRef.current=null; setCallStat('idle'); }); };
      dev.on('registered',onReg); dev.on('unregistered',onUnreg); dev.on('error',onErr); dev.on('incoming',onInc);
      await dev.register();
    }catch(e){ console.error(e); setErr(e.message||String(e)); setDevStat('error'); } })();
    return ()=>{ mounted=false; clearTimeout(tRef.current); try{deviceRef.current?.removeAllListeners?.(); deviceRef.current?.destroy?.(); deviceRef.current=null;}catch{} };
  },[]);
  
  // Fetch recordings, transcriptions, and contacts on mount
  useEffect(() => {
    fetchRecordings();
    fetchTranscriptions();
    fetchContacts();
  }, []);
  const start=async()=>{ 
    setErr(''); 
    const n=norm(num); 
    if(!n||(!n.startsWith('+')&&n.replace(/\D/g,'').length<7)){ 
      setErr('Enter a valid phone number.'); 
      return; 
    } 
    if(!deviceRef.current){ 
      setErr('Device not ready.'); 
      return; 
    } 
    
    try {
      setCallStat('dialing'); 
      const call = await deviceRef.current.connect({params:{To:n}}); 
      actRef.current=call; 
      
      // Attach event listeners to the call object
      call.on('ringing',()=>setCallStat('ringing')); 
      call.on('accept',()=>{
        setCallStat('connected');
        setIsRecording(true); // Start recording indicator
      }); 
      call.on('disconnect',()=>{ 
        setHist(l=>[{id:Date.now(),to:n,direction:'outgoing',status:'completed',at:new Date().toISOString()},...l].slice(0,100)); 
        actRef.current=null; 
        setCallStat('idle'); 
        setIsRecording(false); // Stop recording indicator
        fetchRecordings(); // Refresh recordings list
        fetchTranscriptions(); // Refresh transcriptions list
        fetchContacts(); // Refresh contacts list
      }); 
      call.on('cancel',()=>{ 
        setHist(l=>[{id:Date.now(),to:n,direction:'outgoing',status:'canceled',at:new Date().toISOString()},...l].slice(0,100)); 
        actRef.current=null; 
        setCallStat('idle'); 
        setIsRecording(false); // Stop recording indicator
      }); 
      call.on('error',e=>{
        console.error('Call error:', e);
        setErr(e?.message||'Call error');
        setCallStat('idle');
        actRef.current=null;
        setIsRecording(false); // Stop recording indicator
      });
    } catch (error) {
      console.error('Failed to start call:', error);
      setErr(error?.message||'Failed to start call');
      setCallStat('idle');
    }
  };
  const hang=()=>{ try{actRef.current?.disconnect()}catch{} };
  const dtmf=(d)=>{ try{actRef.current?.sendDigits(d)}catch{} };
  const accept=async()=>{ 
    const c=incRef.current; 
    if(!c) return; 
    
    try {
      await c.accept(); 
      actRef.current=c; 
      setCallStat('connected'); 
      
      c.on('disconnect',()=>{ 
        setHist(l=>[{id:Date.now(),from:c.parameters?.From||'unknown',direction:'incoming',status:'completed',at:new Date().toISOString()},...l].slice(0,100)); 
        if(incRef.current===c) incRef.current=null; 
        actRef.current=null; 
        setCallStat('idle'); 
        setIsRecording(false); // Stop recording indicator
        fetchRecordings(); // Refresh recordings list
        fetchTranscriptions(); // Refresh transcriptions list
        fetchContacts(); // Refresh contacts list
      }); 
      
      c.on('error',(e)=>{
        console.error('Incoming call error:', e);
        setErr(e?.message||'Call error');
        setCallStat('idle');
        if(incRef.current===c) incRef.current=null;
        actRef.current=null;
        setIsRecording(false); // Stop recording indicator
      });
    } catch (error) {
      console.error('Failed to accept call:', error);
      setErr(error?.message||'Failed to accept call');
      setCallStat('idle');
    }
  };
  const reject=()=>{ try{incRef.current?.reject()}catch{} incRef.current=null; setCallStat('idle'); };
  const press=(k)=>{ if(callStat==='connected'&&actRef.current){ dtmf(k); } else { setNum(s=>norm(s+k)); } };
  const back=()=>setNum(s=>s.slice(0,-1)); const clear=()=>setNum('');
  const fetchRecordings=async()=>{ try{ const r=await fetch('http://localhost:5001/api/recordings'); const j=await r.json(); if(r.ok) setRecordings(j.recordings||[]); }catch(e){ console.error('Failed to fetch recordings:',e); } };
  const fetchTranscriptions=async()=>{ try{ const r=await fetch('http://localhost:5001/api/transcriptions'); const j=await r.json(); if(r.ok) setTranscriptions(j.transcriptions||[]); }catch(e){ console.error('Failed to fetch transcriptions:',e); } };
  const fetchContacts=async()=>{ try{ const r=await fetch('http://localhost:5001/api/contacts'); const j=await r.json(); if(r.ok) setConversationContacts(j.contacts||[]); }catch(e){ console.error('Failed to fetch contacts:',e); } };
  const fetchContactContext=async(phoneNumber)=>{ try{ const r=await fetch(`http://localhost:5001/api/contacts/${phoneNumber}/context`); const j=await r.json(); if(r.ok) setContactContext(j); }catch(e){ console.error('Failed to fetch contact context:',e); } };
  const generatePreCallBriefing=async(phoneNumber)=>{ try{ const r=await fetch(`http://localhost:5001/api/contacts/${phoneNumber}/prepare`,{method:'POST'}); const j=await r.json(); if(r.ok) return j; }catch(e){ console.error('Failed to generate briefing:',e); return null; } };
  const addC=(name,phone)=>{ const n=norm(phone); if(!name||!n) return; setContacts(l=>[{id:Date.now(),name,phone:n},...l].slice(0,200)); };
  const devOK=devStat==='ready'; const conn=callStat==='connected';
  return (
    <ErrorBoundary>
      <div className="min-h-screen p-4 md:p-8">
        <div className="max-w-6xl mx-auto grid md:grid-cols-3 gap-6">
          <div className="md:col-span-2 space-y-4">
            <header className="flex items-center justify-between bg-white border rounded px-4 py-3 shadow-sm">
              <div>
                <h1 className="text-xl font-semibold">Twilio Voice Dialer</h1>
                <p className="text-xs text-slate-500">Identity: {id||'(anonymous)'}</p>
              </div>
              <div className="flex items-center gap-3">
                <Pill label={`Device: ${devStat}`} state={devStat} />
                <Pill label={`Call: ${callStat}`} state={callStat} />
                {isRecording && <Pill label="Recording" state="recording" />}
              </div>
            </header>
            {err && <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 rounded">{err}</div>}
            <div className="bg-white border rounded shadow-sm p-4">
              <div className="flex items-center gap-2">
                <input className="flex-1 px-3 py-2 border rounded focus:outline-none focus:ring w-full" placeholder="Enter phone number" value={fmt(num)} onChange={e=>setNum(norm(e.target.value))} disabled={!devOK||conn} />
                {!conn ? <button className="px-4 py-2 bg-green-600 text-white rounded disabled:opacity-50" disabled={!devOK||!num} onClick={start}>Call</button> : <button className="px-4 py-2 bg-red-600 text-white rounded" onClick={hang}>Hang up</button>}
              </div>
              <Pad onPress={press} onBack={back} onClear={clear} inCall={conn} />
              {callStat==='incoming' && (
                <div className="mt-3 flex items-center gap-2">
                  <button className="px-4 py-2 bg-green-600 text-white rounded" onClick={accept}>Accept</button>
                  <button className="px-4 py-2 bg-gray-300 text-gray-800 rounded" onClick={reject}>Reject</button>
                </div>
              )}
            </div>
          </div>
          <aside className="space-y-4">
            <Contacts contacts={contacts} onAdd={addC} onDial={p=>setNum(p)} />
            <History items={hist} />
            <ConversationContacts contacts={conversationContacts} selectedContact={selectedContact} setSelectedContact={setSelectedContact} contactContext={contactContext} showContactDetails={showContactDetails} setShowContactDetails={setShowContactDetails} onFetchContext={fetchContactContext} onGenerateBriefing={generatePreCallBriefing} />
            <Recordings recordings={recordings} showRecordings={showRecordings} setShowRecordings={setShowRecordings} />
            <Transcriptions transcriptions={transcriptions} showTranscriptions={showTranscriptions} setShowTranscriptions={setShowTranscriptions} searchQuery={transcriptionSearch} setSearchQuery={setTranscriptionSearch} />
            <div className="bg-white border rounded shadow-sm p-4 text-sm text-slate-600"><p>Backend: http://localhost:5001  Token: /api/token</p></div>
          </aside>
        </div>
      </div>
    </ErrorBoundary>
  );
}
function Pill({label,state}){ const color=(()=>{ switch(state){ case 'ready': return 'bg-green-100 text-green-700 border-green-200'; case 'connected': return 'bg-emerald-100 text-emerald-700 border-emerald-200'; case 'dialing': case 'ringing': return 'bg-amber-100 text-amber-700 border-amber-200'; case 'incoming': return 'bg-blue-100 text-blue-700 border-blue-200'; case 'recording': return 'bg-red-100 text-red-700 border-red-200'; case 'error': return 'bg-red-100 text-red-700 border-red-200'; default: return 'bg-slate-100 text-slate-700 border-slate-200'; } })(); return <span className={`inline-flex items-center px-2 py-1 rounded border text-xs ${color}`}>{label}</span>; }
function Pad({onPress,onBack,onClear,inCall}){ const keys=[{k:'1',s:''},{k:'2',s:'ABC'},{k:'3',s:'DEF'},{k:'4',s:'GHI'},{k:'5',s:'JKL'},{k:'6',s:'MNO'},{k:'7',s:'PQRS'},{k:'8',s:'TUV'},{k:'9',s:'WXYZ'},{k:'*',s:''},{k:'0',s:'+'},{k:'#',s:''}]; return (
  <div className="mt-4"><div className="grid grid-cols-3 gap-3 w-64 max-w-full">
    {keys.map(({k,s})=> <button key={k} className="h-16 bg-slate-100 rounded border hover:bg-slate-200 active:bg-slate-300 flex flex-col items-center justify-center" onClick={()=>onPress(k)}><span className="text-xl font-semibold">{k}</span><span className="text-xs text-slate-500">{s}</span></button>)}
    <button className="h-16 bg-white rounded border hover:bg-slate-50 flex items-center justify-center" onClick={onBack}></button>
    <button className="h-16 bg-white rounded border hover:bg-slate-50 flex items-center justify-center" onClick={()=>onPress('+')}>+</button>
    <button className="h-16 bg-white rounded border hover:bg-slate-50 flex items-center justify-center" onClick={onClear}>Clear</button>
  </div>{inCall && <div className="text-xs text-slate-500 mt-2">In call: keypad sends DTMF.</div>}</div> ); }
function Contacts({contacts,onAdd,onDial}){ const [name,setName]=useState(''); const [phone,setPhone]=useState(''); return (
  <div className="bg-white border rounded shadow-sm p-4"><h3 className="font-semibold mb-2">Contacts</h3>
    <div className="flex gap-2 mb-3"><input className="flex-1 px-2 py-1 border rounded" placeholder="Name" value={name} onChange={e=>setName(e.target.value)} /><input className="flex-1 px-2 py-1 border rounded" placeholder="Phone" value={phone} onChange={e=>setPhone(e.target.value)} /><button className="px-3 py-1 bg-slate-800 text-white rounded" onClick={()=>{onAdd(name,phone); setName(''); setPhone('')}}>Add</button></div>
    <ul className="space-y-1 max-h-48 overflow-auto">{contacts.map(c=> <li key={c.id} className="flex items-center justify-between text-sm"><div><div className="font-medium">{c.name}</div><div className="text-slate-500">{fmt(c.phone)}</div></div><button className="px-2 py-1 text-xs bg-blue-600 text-white rounded" onClick={()=>onDial(c.phone)}>Dial</button></li>)}{contacts.length===0 && <li className="text-xs text-slate-500">No contacts yet.</li>}</ul>
  </div> ); }
function History({items}){ return (
  <div className="bg-white border rounded shadow-sm p-4"><h3 className="font-semibold mb-2">Call History</h3>
    <ul className="space-y-1 max-h-64 overflow-auto text-sm">{items.map(h=> <li key={h.id} className="flex items-center justify-between"><div><div className="font-medium">{h.direction==='outgoing'?`To ${fmt(h.to||'')}`:`From ${fmt(h.from||'')}`}</div><div className="text-xs text-slate-500">{new Date(h.at).toLocaleString()}  {h.status}</div></div></li>)}{items.length===0 && <li className="text-xs text-slate-500">No calls yet.</li>}</ul>
  </div> ); }

function Recordings({recordings,showRecordings,setShowRecordings}){ 
  const formatDuration=(seconds)=>{ const mins=Math.floor(seconds/60); const secs=seconds%60; return `${mins}:${secs.toString().padStart(2,'0')}`; };
  const formatDate=(dateStr)=>{ return new Date(dateStr).toLocaleString(); };
  
  return (
    <div className="bg-white border rounded shadow-sm p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold">Recordings</h3>
        <button 
          className="text-xs px-2 py-1 bg-slate-800 text-white rounded"
          onClick={()=>setShowRecordings(!showRecordings)}
        >
          {showRecordings ? 'Hide' : 'Show'}
        </button>
      </div>
      
      {showRecordings && (
        <ul className="space-y-2 max-h-64 overflow-auto text-sm">
          {recordings.map(r=> (
            <li key={r.sid} className="border rounded p-2">
              <div className="flex items-center justify-between mb-1">
                <div className="font-medium text-xs">Call {r.callSid?.slice(-8)}</div>
                <div className="text-xs text-slate-500">{formatDuration(r.duration)}</div>
              </div>
              <div className="text-xs text-slate-500 mb-2">{formatDate(r.createdAt)}</div>
              <div className="flex gap-1">
                <button 
                  className="text-xs px-2 py-1 bg-blue-600 text-white rounded"
                  onClick={()=>window.open(`http://localhost:5001/api/recordings/${r.sid}/download`)}
                >
                  Download
                </button>
                <span className="text-xs px-2 py-1 bg-slate-100 text-slate-600 rounded">
                  {r.channels} channels
                </span>
              </div>
            </li>
          ))}
          {recordings.length===0 && <li className="text-xs text-slate-500">No recordings yet.</li>}
        </ul>
      )}
    </div>
  ); }

function Transcriptions({transcriptions,showTranscriptions,setShowTranscriptions,searchQuery,setSearchQuery}){ 
  const formatDate=(dateStr)=>{ return new Date(dateStr).toLocaleString(); };
  const formatConfidence=(conf)=>{ return `${Math.round(conf * 100)}%`; };
  
  // Filter transcriptions based on search query
  const filteredTranscriptions = transcriptions.filter(t => 
    !searchQuery || 
    t.text?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.metadata?.topics?.some(topic => topic.toLowerCase().includes(searchQuery.toLowerCase()))
  );
  
  return (
    <div className="bg-white border rounded shadow-sm p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold">Transcriptions</h3>
        <button 
          className="text-xs px-2 py-1 bg-slate-800 text-white rounded"
          onClick={()=>setShowTranscriptions(!showTranscriptions)}
        >
          {showTranscriptions ? 'Hide' : 'Show'}
        </button>
      </div>
      
      {showTranscriptions && (
        <>
          <div className="mb-3">
            <input 
              className="w-full px-2 py-1 border rounded text-xs"
              placeholder="Search transcriptions..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          
          <ul className="space-y-3 max-h-64 overflow-auto text-sm">
            {filteredTranscriptions.map(t=> (
              <li key={t.sid} className="border rounded p-2">
                <div className="flex items-center justify-between mb-1">
                  <div className="font-medium text-xs">Call {t.callSid?.slice(-8)}</div>
                  <div className="text-xs text-slate-500">{formatConfidence(t.confidence)}</div>
                </div>
                <div className="text-xs text-slate-500 mb-2">{formatDate(t.createdAt)}</div>
                
                {/* Transcription preview */}
                <div className="text-xs text-slate-700 mb-2 max-h-16 overflow-hidden">
                  {t.text?.substring(0, 100)}...
                </div>
                
                {/* Metadata */}
                {t.metadata && (
                  <div className="mb-2">
                    {t.metadata.topics?.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-1">
                        {t.metadata.topics.map((topic, i) => (
                          <span key={i} className="text-xs px-1 py-0.5 bg-blue-100 text-blue-700 rounded">
                            {topic}
                          </span>
                        ))}
                      </div>
                    )}
                    {t.metadata.actionItems?.length > 0 && (
                      <div className="text-xs text-amber-600">
                        {t.metadata.actionItems.length} action item(s)
                      </div>
                    )}
                  </div>
                )}
                
                {/* Export buttons */}
                <div className="flex gap-1">
                  <button 
                    className="text-xs px-2 py-1 bg-green-600 text-white rounded"
                    onClick={()=>window.open(`http://localhost:5001/api/transcriptions/${t.sid}/export?format=json`)}
                  >
                    JSON
                  </button>
                  <button 
                    className="text-xs px-2 py-1 bg-purple-600 text-white rounded"
                    onClick={()=>window.open(`http://localhost:5001/api/transcriptions/${t.sid}/export?format=markdown`)}
                  >
                    MD
                  </button>
                  <button 
                    className="text-xs px-2 py-1 bg-orange-600 text-white rounded"
                    onClick={()=>window.open(`http://localhost:5001/api/transcriptions/${t.sid}/export?format=vector`)}
                  >
                    Vector
                  </button>
                </div>
              </li>
            ))}
            {filteredTranscriptions.length===0 && (
              <li className="text-xs text-slate-500">
                {searchQuery ? 'No transcriptions match your search.' : 'No transcriptions yet.'}
              </li>
            )}
          </ul>
        </>
      )}
    </div>
  ); }

function ConversationContacts({contacts, selectedContact, setSelectedContact, contactContext, showContactDetails, setShowContactDetails, onFetchContext, onGenerateBriefing}){ 
  const formatDate=(dateStr)=>{ return new Date(dateStr).toLocaleString(); };
  const formatPhone=(phone)=>{ return phone.replace(/^\+1/, '').replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3'); };
  
  const handleContactSelect = async (contact) => {
    setSelectedContact(contact);
    await onFetchContext(contact.phoneNumber);
    setShowContactDetails(true);
  };
  
  const handleGenerateBriefing = async (phoneNumber) => {
    const briefing = await onGenerateBriefing(phoneNumber);
    if (briefing) {
      console.log('Pre-call briefing:', briefing);
      // You could display this in a modal or notification
      alert(`Pre-call briefing generated for ${formatPhone(phoneNumber)}`);
    }
  };
  
  return (
    <div className="bg-white border rounded shadow-sm p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold">Conversation Contacts</h3>
        <button 
          className="text-xs px-2 py-1 bg-slate-800 text-white rounded"
          onClick={()=>setShowContactDetails(!showContactDetails)}
        >
          {showContactDetails ? 'Hide' : 'Show'}
        </button>
      </div>
      
      {showContactDetails && (
        <>
          {selectedContact && contactContext && (
            <div className="mb-4 p-3 bg-blue-50 border rounded">
              <h4 className="font-medium text-sm mb-2">Contact Context: {formatPhone(selectedContact.phoneNumber)}</h4>
              
              {/* Relationship Summary */}
              <div className="mb-2">
                <div className="text-xs text-slate-600">
                  <strong>Relationship:</strong> {contactContext.summary?.relationship || 'Unknown'} • 
                  <strong>Total Calls:</strong> {contactContext.summary?.totalCalls || 0} • 
                  <strong>Frequency:</strong> {contactContext.summary?.communicationFrequency || 'Unknown'}
                </div>
              </div>
              
              {/* Recent Topics */}
              {contactContext.recentTopics?.length > 0 && (
                <div className="mb-2">
                  <div className="text-xs text-slate-600">
                    <strong>Recent Topics:</strong> {contactContext.recentTopics.slice(0, 3).join(', ')}
                  </div>
                </div>
              )}
              
              {/* Pending Action Items */}
              {contactContext.pendingActionItems?.length > 0 && (
                <div className="mb-2">
                  <div className="text-xs text-amber-600">
                    <strong>Pending Actions:</strong> {contactContext.pendingActionItems.length} item(s)
                  </div>
                </div>
              )}
              
              {/* AI Suggestions */}
              {contactContext.aiSuggestions?.length > 0 && (
                <div className="mb-2">
                  <div className="text-xs text-purple-600">
                    <strong>AI Suggestions:</strong> {contactContext.aiSuggestions[0]?.message}
                  </div>
                </div>
              )}
              
              <button 
                className="text-xs px-2 py-1 bg-green-600 text-white rounded"
                onClick={() => handleGenerateBriefing(selectedContact.phoneNumber)}
              >
                Generate Briefing
              </button>
            </div>
          )}
          
          <ul className="space-y-2 max-h-64 overflow-auto text-sm">
            {contacts.map(contact => (
              <li key={contact.phoneNumber} className="border rounded p-2">
                <div className="flex items-center justify-between mb-1">
                  <div className="font-medium text-xs">{formatPhone(contact.phoneNumber)}</div>
                  <div className="text-xs text-slate-500">{contact.totalCalls} calls</div>
                </div>
                <div className="text-xs text-slate-500 mb-2">
                  Last: {formatDate(contact.lastContact)} • {contact.relationship}
                </div>
                
                {/* Recent Topics */}
                {contact.recentTopics?.length > 0 && (
                  <div className="mb-2">
                    <div className="flex flex-wrap gap-1">
                      {contact.recentTopics.map((topic, i) => (
                        <span key={i} className="text-xs px-1 py-0.5 bg-blue-100 text-blue-700 rounded">
                          {topic}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                
                {/* Action Items */}
                {contact.pendingActionItems > 0 && (
                  <div className="text-xs text-amber-600 mb-2">
                    {contact.pendingActionItems} pending action item(s)
                  </div>
                )}
                
                <div className="flex gap-1">
                  <button 
                    className="text-xs px-2 py-1 bg-blue-600 text-white rounded"
                    onClick={() => handleContactSelect(contact)}
                  >
                    View Context
                  </button>
                  <button 
                    className="text-xs px-2 py-1 bg-green-600 text-white rounded"
                    onClick={() => handleGenerateBriefing(contact.phoneNumber)}
                  >
                    Briefing
                  </button>
                </div>
              </li>
            ))}
            {contacts.length===0 && (
              <li className="text-xs text-slate-500">No conversation contacts yet.</li>
            )}
          </ul>
        </>
      )}
    </div>
  ); }