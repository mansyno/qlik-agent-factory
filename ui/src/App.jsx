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

  const handleRun = async (dataDir, appName, pipeline) => {
    await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataDir, appName, pipeline }) })
  }
  const handleStop = () => fetch('/api/stop', { method: 'POST' })
  const handlePause = () => fetch('/api/pause', { method: 'POST' })
  const handleResume = () => fetch('/api/resume', { method: 'POST' })

  const btnBase = { display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 7, border: 'none', fontWeight: 600, fontSize: 13, cursor: 'pointer', transition: 'all 0.15s' }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--color-bg)' }}>
      <Header isRunning={isRunning} connected={connected} />

      <div style={{ maxWidth: 1600, margin: '0 auto', padding: '0 24px 40px' }}>
        <ControlPanel onRun={handleRun} isRunning={isRunning} />

        {/* Job control bar — visible only while running */}
        {isRunning && (
          <div style={{ display: 'flex', gap: 10, marginTop: 12, justifyContent: 'flex-end' }}>
            {isPaused ? (
              <button onClick={handleResume} style={{ ...btnBase, background: 'rgba(63,185,80,0.15)', color: 'var(--color-success)', border: '1px solid rgba(63,185,80,0.3)' }}>
                <Play size={13} /> Resume
              </button>
            ) : (
              <button onClick={handlePause} style={{ ...btnBase, background: 'rgba(210,153,34,0.15)', color: 'var(--color-warning)', border: '1px solid rgba(210,153,34,0.3)' }}>
                <Pause size={13} /> Pause
              </button>
            )}
            <button onClick={handleStop} style={{ ...btnBase, background: 'rgba(248,81,73,0.12)', color: 'var(--color-error)', border: '1px solid rgba(248,81,73,0.3)' }}>
              <Square size={13} /> Stop
            </button>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 12 }}>
          <div style={{ minWidth: 0 }}><ReasoningFeed logs={logs} isRunning={isRunning} /></div>
          <div style={{ minWidth: 0 }}><ScriptForge script={script} phase={scriptPhase} /></div>
        </div>

        {artifacts && (
          <div style={{ marginTop: 20 }}>
            <ModelArtifacts profiles={artifacts} />
          </div>
        )}

        <DebugFileViewer />
      </div>
    </div>
  )
}

