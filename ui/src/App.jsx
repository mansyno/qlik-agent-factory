import { useState, useEffect } from 'react'
import { io } from 'socket.io-client'
import { Square, Pause, Play } from 'lucide-react'
import Header from './components/Header'
import ControlPanel from './components/ControlPanel'
import ReasoningFeed from './components/ReasoningFeed'
import ModelArtifacts from './components/ModelArtifacts'
import ScriptForge from './components/ScriptForge'
import DebugFileViewer from './components/DebugFileViewer'

const socket = io('http://localhost:3001')

export default function App() {
  const [logs, setLogs] = useState([])
  const [isRunning, setIsRunning] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [artifacts, setArtifacts] = useState(null)
  const [script, setScript] = useState('')
  const [scriptPhase, setScriptPhase] = useState('')
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    socket.on('connect', () => setConnected(true))
    socket.on('disconnect', () => setConnected(false))
    socket.on('agent-log', (entry) => setLogs(prev => [...prev, entry]))
    socket.on('job-started', () => { setIsRunning(true); setIsPaused(false); setLogs([]); setArtifacts(null); setScript('') })
    socket.on('job-complete', () => { setIsRunning(false); setIsPaused(false) })
    socket.on('job-stopping', () => { setIsRunning(false); setIsPaused(false) })
    socket.on('job-paused', () => setIsPaused(true))
    socket.on('job-resumed', () => setIsPaused(false))
    socket.on('model-artifact', (data) => setArtifacts(data))
    socket.on('script-update', ({ phase, script: s }) => { setScript(s); setScriptPhase(phase) })
    return () => socket.off()
  }, [])

  const handleRun = async (dataDir, appName, pipeline, projectName, options = {}) => {
    const { aiEngine = 'gemini', aiModel = null } = options;
    console.log('[UI App] Calling handleRun:', { projectName, dataDir, appName, pipeline, aiEngine, aiModel });
    try {
        const res = await fetch('/api/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectName, dataDir, appName, pipeline, aiEngine, aiModel })
        });
        if (!res.ok) {
            const err = await res.json();
            console.error('[UI App] Server responded with error:', err);
            alert(`Server Error: ${err.error || res.statusText}`);
        } else {
            console.log('[UI App] Request sent successfully');
        }
    } catch (err) {
        console.error('[UI App] Fetch failed entirely:', err);        alert(`Network/Fetch Error: ${err.message}`);
    }
  }
  const handleStop = () => fetch('/api/stop', { method: 'POST' })
  const handlePause = () => fetch('/api/pause', { method: 'POST' })
  const handleResume = () => fetch('/api/resume', { method: 'POST' })

  const btnBase = { display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 7, border: 'none', fontWeight: 600, fontSize: 13, cursor: 'pointer', transition: 'all 0.15s' }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--color-bg)', overflow: 'hidden' }}>
      <Header isRunning={isRunning} connected={connected} />

      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: '320px 1fr', 
        flex: 1, 
        overflow: 'hidden',
        background: 'var(--color-bg)' 
      }}>
        {/* Left Sidebar */}
        <aside style={{ 
          background: 'var(--color-surface)', 
          borderRight: '1px solid var(--color-border)', 
          display: 'flex', 
          flexDirection: 'column', 
          overflowY: 'auto',
          padding: '16px',
          gap: '20px'
        }}>
          <ControlPanel onRun={handleRun} isRunning={isRunning} />

          {/* Job control bar — visible only while running */}
          {isRunning && (
            <div style={{ display: 'flex', gap: 10 }}>
              {isPaused ? (
                <button onClick={handleResume} style={{ ...btnBase, flex: 1, justifyContent: 'center', background: 'rgba(63,185,80,0.15)', color: 'var(--color-success)', border: '1px solid rgba(63,185,80,0.3)' }}>
                  <Play size={13} /> Resume
                </button>
              ) : (
                <button onClick={handlePause} style={{ ...btnBase, flex: 1, justifyContent: 'center', background: 'rgba(210,153,34,0.15)', color: 'var(--color-warning)', border: '1px solid rgba(210,153,34,0.3)' }}>
                  <Pause size={13} /> Pause
                </button>
              )}
              <button onClick={handleStop} style={{ ...btnBase, flex: 1, justifyContent: 'center', background: 'rgba(248,81,73,0.12)', color: 'var(--color-error)', border: '1px solid rgba(248,81,73,0.3)' }}>
                <Square size={13} /> Stop
              </button>
            </div>
          )}
        </aside>

        {/* Main Content Area */}
        <main style={{ 
          flex: 1, 
          display: 'flex', 
          flexDirection: 'column', 
          padding: '20px', 
          overflowY: 'auto', 
          gap: 20 
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 20, minHeight: 0, flex: 1 }}>
            <ReasoningFeed logs={logs} isRunning={isRunning} />
            <ScriptForge script={script} phase={scriptPhase} />
          </div>

          {artifacts && (
            <div style={{ flexShrink: 0 }}>
              <ModelArtifacts profiles={artifacts} />
            </div>
          )}

          <div style={{ flexShrink: 0 }}>
            <DebugFileViewer />
          </div>
        </main>
      </div>
    </div>
  )
}
