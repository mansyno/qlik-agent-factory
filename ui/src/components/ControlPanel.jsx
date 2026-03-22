import { useState, useEffect } from 'react'
import { Play, FolderOpen, Tag, Box, CheckSquare, Square, ChevronRight, AlertTriangle, ChevronDown } from 'lucide-react'

const ALL_PHASES = [
    { id: 'architect', label: 'Architect (Phase 1 & 2)' },
    { id: 'enhancer', label: 'Enhancer (Phase 4)' },
    { id: 'layout', label: 'Layout (Phase 5)' },
]

export default function ControlPanel({ onRun, isRunning }) {
    const [dataDir, setDataDir] = useState('./data2')
    const [projects, setProjects] = useState([])
    const [selectedProject, setSelectedProject] = useState('')
    const [newProjectName, setNewProjectName] = useState('')
    const [runs, setRuns] = useState([])
    const [selectedRun, setSelectedRun] = useState('')
    const [newRunName, setNewRunName] = useState('')
    const [pipeline, setPipeline] = useState(['architect', 'enhancer', 'layout'])
    
    // AI Engine State
    const [aiEngine, setAiEngine] = useState('gemini')
    const [lmsModels, setLmsModels] = useState([])
    const [selectedLmsModel, setSelectedLmsModel] = useState('')
    const [loadedLmsModel, setLoadedLmsModel] = useState(null)
    const [lmsStatus, setLmsStatus] = useState('checking') // 'checking', 'online', 'offline'

    const fetchModels = () => {
        setLmsStatus('checking');
        fetch('http://localhost:3001/api/models')
            .then(async r => {
                if (r.status === 503) {
                    setLmsStatus('offline');
                    return null;
                }
                if (!r.ok) throw new Error('Network response was not ok');
                return r.json();
            })
            .then(data => {
                if (data) {
                    setLmsStatus('online');
                    if (data.models && data.models.length > 0) {
                        setLmsModels(data.models)
                        if (!selectedLmsModel) setSelectedLmsModel(data.models[0])
                    } else {
                        setLmsModels([]);
                    }
                    setLoadedLmsModel(data.loadedModel);
                }
            })
            .catch(e => {
                console.log("LM Studio not running or unreachable", e);
                setLmsStatus('offline');
            })
    };

    useEffect(() => {
        if (aiEngine === 'lmstudio') {
            fetchModels();
        }
    }, [aiEngine])

    const handleStartLms = async () => {
        setLmsStatus('checking');
        try {
            await fetch('http://localhost:3001/api/lmstudio/start', { method: 'POST' });
            setTimeout(fetchModels, 3000);
        } catch (e) {
            setLmsStatus('offline');
        }
    };

    const handleLoadModel = async () => {
        if (!selectedLmsModel) return;
        setLmsStatus('checking');
        try {
            await fetch('http://localhost:3001/api/lmstudio/load', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelId: selectedLmsModel })
            });
            fetchModels();
        } catch (e) {
            alert('Failed to load model');
            fetchModels();
        }
    };

    const handleUnloadModels = async () => {
        try {
            await fetch('http://localhost:3001/api/lmstudio/unload', { method: 'POST' });
            fetchModels();
        } catch (e) {
            alert('Failed to unload models');
        }
    };

    const handleShutdownLms = async () => {
        try {
            await fetch('http://localhost:3001/api/lmstudio/shutdown', { method: 'POST' });
            setLmsStatus('offline');
            setLoadedLmsModel(null);
        } catch (e) {
            alert('Failed to shutdown server');
        }
    };

    useEffect(() => {
        fetch('http://localhost:3001/api/projects')
            .then(r => r.json())
            .then(data => {
                setProjects(data)
                if (data.length > 0) setSelectedProject(data[0])
            })
            .catch(e => console.error("Failed to load projects", e))
    }, [])

    useEffect(() => {
        if (!selectedProject || selectedProject === '_new_') {
            setRuns([])
            setSelectedRun('_new_')
            return
        }
        fetch(`http://localhost:3001/api/projects/${selectedProject}/runs`)
            .then(r => r.json())
            .then(data => {
                setRuns(data)
                if (data.length > 0) {
                    setSelectedRun(prev => data.find(d => d.name === prev) ? prev : data[0].name)
                } else {
                    setSelectedRun('_new_')
                }
            })
            .catch(e => console.error("Failed to load runs", e))
    }, [selectedProject, isRunning])

    useEffect(() => {
         if (selectedProject && selectedProject !== '_new_' && selectedRun && selectedRun !== '_new_') {
             fetch(`http://localhost:3001/api/projects/${selectedProject}/runs/${selectedRun}/config`)
                 .then(r => r.json())
                 .then(data => { if (data && data.dataDir) setDataDir(data.dataDir) })
                 .catch(e => console.error("Failed to load run config", e))
         }
    }, [selectedRun, selectedProject])

    const togglePhase = (id) => {
        if (isRunning) return;
        setPipeline(prev => {
            const has = prev.includes(id);
            let next = has ? prev.filter(p => p !== id) : [...prev, id];
            next.sort((a, b) => ALL_PHASES.findIndex(p => p.id === a) - ALL_PHASES.findIndex(p => p.id === b));
            if (next.includes('architect') && next.includes('layout') && !next.includes('enhancer')) {
                if (id === 'enhancer') next = ['architect'];
                else next = ['architect', 'enhancer', 'layout'];
            }
            return next;
        });
    }

    const finalProject = selectedProject === '_new_' ? newProjectName : selectedProject;
    const finalRun = selectedRun === '_new_' ? newRunName : (selectedRun.includes('_') ? selectedRun.substring(selectedRun.indexOf('_') + 1) : selectedRun);
    const selectedRunObj = runs.find(r => r.name === selectedRun);
    const isCurrentAppMissing = selectedRunObj ? !selectedRunObj.appExists : false;

    useEffect(() => {
        if (isCurrentAppMissing && !pipeline.includes('architect')) {
            setPipeline(prev => {
                const next = ['architect', ...prev.filter(p => p !== 'architect')];
                next.sort((a, b) => ALL_PHASES.findIndex(p => p.id === a) - ALL_PHASES.findIndex(p => p.id === b));
                return next;
            });
        }
    }, [isCurrentAppMissing, pipeline])

    const isReady = !isRunning && dataDir && finalProject && finalRun && pipeline.length > 0;

    const handleSubmit = async (e) => {
        e.preventDefault()
        if (isReady) {
            // we pass AI engine and model as an options object as the 5th parameter or modifying onRun signature
            await onRun(dataDir, finalRun, pipeline, finalProject, { aiEngine, aiModel: selectedLmsModel })
        }
    }

    const handleBrowse = async () => {
        const res = await fetch('http://localhost:3001/api/utils/browse-folder');
        const data = await res.json();
        if (data.path) setDataDir(data.path);
    };

    const inputStyle = {
        background: 'var(--color-surface2)',
        border: '1px solid var(--color-border)',
        borderRadius: 4,
        padding: '4px 8px',
        color: 'var(--color-text)',
        fontSize: 12,
        width: '100%',
        outline: 'none',
        fontFamily: 'JetBrains Mono, monospace',
    }
    const labelStyle = { fontSize: 10, color: 'var(--color-muted)', display: 'block', marginBottom: 2, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text)', textTransform: 'uppercase', letterSpacing: '0.1em', borderBottom: '1px solid var(--color-border)', paddingBottom: 6 }}>
                Workspace Setup
            </div>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                    <label style={labelStyle}>1. Data Source</label>
                    <div style={{ display: 'flex', gap: 4 }}>
                        <input value={dataDir} onChange={e => setDataDir(e.target.value)} style={inputStyle} placeholder="./data2" disabled={isRunning} />
                        <button type="button" onClick={handleBrowse} disabled={isRunning} style={{ padding: '0 8px', background: 'var(--color-surface2)', border: '1px solid var(--color-border)', borderRadius: 4, color: 'var(--color-text)', fontSize: 10, fontWeight: 600, cursor: 'pointer' }}>
                            ...
                        </button>
                    </div>
                </div>

                <div>
                     <label style={labelStyle}>2. Project Group</label>
                     <div style={{ position: 'relative' }}>
                         <select value={selectedProject} onChange={e => setSelectedProject(e.target.value)} disabled={isRunning} style={{ ...inputStyle, appearance: 'none' }}>
                             {projects.map(p => <option key={p} value={p}>{p}</option>)}
                             <option value="_new_">+ New Project...</option>
                         </select>
                         <ChevronDown size={12} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-muted)', pointerEvents: 'none' }} />
                     </div>
                     {selectedProject === '_new_' && <input value={newProjectName} onChange={e => setNewProjectName(e.target.value)} style={{ ...inputStyle, marginTop: 4 }} placeholder="project_name" disabled={isRunning} />}
                </div>

                <div>
                     <label style={labelStyle}>3. Target App / Run</label>
                     <div style={{ position: 'relative' }}>
                         <select value={selectedRun} onChange={e => setSelectedRun(e.target.value)} disabled={isRunning || !selectedProject} style={{ ...inputStyle, appearance: 'none' }}>
                             <option value="_new_">+ New App...</option>
                             {runs.map(r => <option key={r.name} value={r.name}>{r.name} {!r.appExists ? '⚠️ (app missing)' : ''}</option>)}
                         </select>
                         <ChevronDown size={12} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-muted)', pointerEvents: 'none' }} />
                     </div>
                     {selectedRun === '_new_' && <input value={newRunName} onChange={e => setNewRunName(e.target.value)} style={{ ...inputStyle, marginTop: 4 }} placeholder="Agent_Output" disabled={isRunning} />}
                </div>

                <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 10 }}>
                     <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                        <label style={labelStyle}>4. AI Engine</label>
                        {aiEngine === 'lmstudio' && lmsStatus === 'online' && !loadedLmsModel && (
                            <button type="button" onClick={handleShutdownLms} style={{ background: 'none', border: 'none', color: 'var(--color-error)', fontSize: 9, cursor: 'pointer', opacity: 0.7 }}>Shutdown Server</button>
                        )}
                     </div>
                     <div style={{ display: 'flex', gap: 8, marginBottom: aiEngine === 'lmstudio' ? 4 : 0 }}>
                        <div 
                            onClick={() => !isRunning && setAiEngine('gemini')}
                            style={{ flex: 1, padding: '4px', textAlign: 'center', fontSize: 11, cursor: isRunning ? 'not-allowed' : 'pointer', borderRadius: 4, background: aiEngine === 'gemini' ? 'var(--color-accent-glow)' : 'var(--color-surface2)', border: `1px solid ${aiEngine === 'gemini' ? 'var(--color-accent)' : 'var(--color-border)'}`, color: aiEngine === 'gemini' ? 'var(--color-accent)' : 'var(--color-text)' }}>
                            Google Gemini
                        </div>
                        <div 
                            onClick={() => !isRunning && setAiEngine('lmstudio')}
                            style={{ flex: 1, padding: '4px', textAlign: 'center', fontSize: 11, cursor: isRunning ? 'not-allowed' : 'pointer', borderRadius: 4, background: aiEngine === 'lmstudio' ? 'var(--color-accent-glow)' : 'var(--color-surface2)', border: `1px solid ${aiEngine === 'lmstudio' ? 'var(--color-accent)' : 'var(--color-border)'}`, color: aiEngine === 'lmstudio' ? 'var(--color-accent)' : 'var(--color-text)' }}>
                            LM Studio (Local)
                        </div>
                     </div>
                     {aiEngine === 'lmstudio' && lmsStatus === 'offline' && (
                         <button type="button" onClick={handleStartLms} disabled={isRunning} style={{ marginTop: 4, width: '100%', padding: '6px', background: 'rgba(210,153,34,0.15)', color: 'var(--color-warning)', border: '1px solid rgba(210,153,34,0.3)', borderRadius: 4, fontSize: 11, cursor: 'pointer', fontWeight: 600 }}>
                             ⚠️ Start Local LM Studio Server
                         </button>
                     )}
                     {aiEngine === 'lmstudio' && lmsStatus === 'checking' && (
                         <div style={{ marginTop: 4, fontSize: 11, color: 'var(--color-muted)', textAlign: 'center' }}>Connecting to local engine...</div>
                     )}
                     {aiEngine === 'lmstudio' && lmsStatus === 'online' && (
                         <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
                             <div style={{ position: 'relative' }}>
                                 <select value={selectedLmsModel} onChange={e => setSelectedLmsModel(e.target.value)} disabled={isRunning} style={{ ...inputStyle, appearance: 'none' }}>
                                     {lmsModels.length > 0 ? lmsModels.map(m => <option key={m} value={m}>{m}</option>) : <option value="">No local models found...</option>}
                                 </select>
                                 <ChevronDown size={12} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-muted)', pointerEvents: 'none' }} />
                             </div>
                             
                             {selectedLmsModel !== loadedLmsModel ? (
                                 <button type="button" onClick={handleLoadModel} disabled={isRunning || !selectedLmsModel} style={{ width: '100%', padding: '6px', background: 'var(--color-accent)', border: 'none', borderRadius: 4, color: 'white', fontSize: 11, cursor: 'pointer', fontWeight: 600 }}>
                                     Load Model to VRAM
                                 </button>
                             ) : (
                                 <div style={{ display: 'flex', gap: 4 }}>
                                     <div style={{ flex: 1, padding: '6px', background: 'rgba(63,185,80,0.15)', color: 'var(--color-success)', border: '1px solid rgba(63,185,80,0.3)', borderRadius: 4, fontSize: 10, textAlign: 'center', fontWeight: 600 }}>
                                         ✅ Model Loaded
                                     </div>
                                     <button type="button" onClick={handleUnloadModels} disabled={isRunning} style={{ padding: '0 8px', background: 'var(--color-surface2)', border: '1px solid var(--color-border)', borderRadius: 4, color: 'var(--color-text)', fontSize: 10, cursor: 'pointer' }}>
                                         Unload
                                     </button>
                                 </div>
                             )}
                         </div>
                     )}
                </div>

                <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 10 }}>
                     <label style={labelStyle}>5. Pipeline</label>
                     <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                        {ALL_PHASES.map((phase) => {
                            const isChecked = pipeline.includes(phase.id);
                            const isDisabled = isRunning || !dataDir || !finalProject || !finalRun || (phase.id === 'architect' && isCurrentAppMissing);
                            return (
                                <div key={phase.id} onClick={() => { if (!isDisabled) togglePhase(phase.id); }} 
                                    title={phase.id === 'architect' && isCurrentAppMissing ? "Architect phase is mandatory because the app does not exist yet" : ""}
                                    style={{
                                    display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 4,
                                    background: isChecked ? 'var(--color-accent-glow)' : 'var(--color-surface2)',
                                    border: `1px solid ${isChecked ? 'var(--color-accent)' : 'var(--color-border)'}`,
                                    color: isChecked ? 'var(--color-accent)' : 'var(--color-muted)',
                                    cursor: isDisabled ? 'not-allowed' : 'pointer', opacity: isDisabled ? 0.6 : 1, fontSize: 11, transition: 'all 0.1s'
                                }}>
                                    {isChecked ? <CheckSquare size={12} /> : <Square size={12} />}
                                    {phase.label.split(' (')[0]}
                                    {phase.id === 'architect' && isCurrentAppMissing && <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--color-warning)', fontWeight: 600 }}>(app missing)</span>}
                                </div>
                            );
                        })}
                     </div>
                </div>

                <button type="submit" disabled={!isReady} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px', width: '100%',
                    background: !isReady ? 'var(--color-surface2)' : 'linear-gradient(135deg, #2f81f7, #8b5cf6)',
                    border: 'none', borderRadius: 6, color: !isReady ? 'var(--color-muted)' : 'white', fontWeight: 700, fontSize: 12, cursor: !isReady ? 'not-allowed' : 'pointer', transition: 'all 0.2s', boxShadow: !isReady ? 'none' : '0 4px 12px rgba(47,129,247,0.2)'
                }}>
                    {isRunning ? <div style={{ width: 12, height: 12, border: '2px solid var(--color-muted)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} /> : <Play size={12} />}
                    {isRunning ? 'Running...' : 'Launch Agent'}
                </button>
            </form>
        </div>
    )
}
