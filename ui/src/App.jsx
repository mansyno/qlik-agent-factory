import { useState, useEffect, useRef } from 'react'
import { io } from 'socket.io-client'
import Header from './components/Header'
import ControlPanel from './components/ControlPanel'
import ReasoningFeed from './components/ReasoningFeed'
import ModelArtifacts from './components/ModelArtifacts'
import ScriptForge from './components/ScriptForge'

const socket = io('http://localhost:3001')

export default function App() {
  const [logs, setLogs] = useState([])
  const [isRunning, setIsRunning] = useState(false)
  const [artifacts, setArtifacts] = useState(null)
  const [script, setScript] = useState('')
  const [scriptPhase, setScriptPhase] = useState('')
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    socket.on('connect', () => setConnected(true))
    socket.on('disconnect', () => setConnected(false))

    socket.on('agent-log', (entry) => {
      setLogs(prev => [...prev, entry])
    })

    socket.on('job-started', () => {
      setIsRunning(true)
      setLogs([])
      setArtifacts(null)
      setScript('')
    })

    socket.on('job-complete', () => setIsRunning(false))

    socket.on('model-artifact', (data) => setArtifacts(data))

    socket.on('script-update', ({ phase, script: s }) => {
      setScript(s)
      setScriptPhase(phase)
    })

    return () => socket.off()
  }, [])

  const handleRun = async (dataDir, appName, pipeline) => {
    await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataDir, appName, pipeline })
    })
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--color-bg)' }}>
      <Header isRunning={isRunning} connected={connected} />

      <div style={{ maxWidth: 1600, margin: '0 auto', padding: '0 24px 40px' }}>
        <ControlPanel onRun={handleRun} isRunning={isRunning} />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 20 }}>
          <div style={{ minWidth: 0 }}><ReasoningFeed logs={logs} isRunning={isRunning} /></div>
          <div style={{ minWidth: 0 }}><ScriptForge script={script} phase={scriptPhase} /></div>
        </div>

        {artifacts && (
          <div style={{ marginTop: 20 }}>
            <ModelArtifacts profiles={artifacts} />
          </div>
        )}
      </div>
    </div>
  )
}
