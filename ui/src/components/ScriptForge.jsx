import { Code2, ChevronUp, ChevronDown } from 'lucide-react'
import { useState } from 'react'

const PHASE_LABEL = { architect: 'Architect Output', enhancer: 'Enriched Output' }
const PHASE_COLOR = { architect: 'var(--color-warning)', enhancer: 'var(--color-success)' }

export default function ScriptForge({ script, phase }) {
    const [collapsed, setCollapsed] = useState(false)
    const lines = script ? script.split('\n') : []

    return (
        <div style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 12,
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
        }}>
            {/* Header */}
            <div style={{
                padding: '12px 16px',
                borderBottom: '1px solid var(--color-border)',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                cursor: 'pointer',
                userSelect: 'none',
            }} onClick={() => setCollapsed(c => !c)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Code2 size={14} color="var(--color-muted)" />
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                        Script Forge
                    </span>
                    {phase && (
                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 99, background: 'var(--color-surface2)', color: PHASE_COLOR[phase] || 'var(--color-muted)', fontWeight: 600 }}>
                            {PHASE_LABEL[phase] || phase}
                        </span>
                    )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: 'var(--color-muted)' }}>{lines.length} lines</span>
                    {collapsed ? <ChevronDown size={14} color="var(--color-muted)" /> : <ChevronUp size={14} color="var(--color-muted)" />}
                </div>
            </div>

            {/* Code view */}
            {!collapsed && (
                <div style={{ flex: 1, overflowY: 'auto', padding: '12px 0' }}>
                    {!script ? (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-muted)', fontSize: 13 }}>
                            Script will appear here after the Architect phase...
                        </div>
                    ) : (
                        <pre style={{ margin: 0 }}>
                            {lines.map((line, i) => (
                                <div key={i} style={{ display: 'flex', gap: 0 }}>
                                    <span style={{
                                        display: 'inline-block', width: 44, textAlign: 'right',
                                        paddingRight: 16, color: 'var(--color-border)',
                                        fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
                                        userSelect: 'none', flexShrink: 0
                                    }}>{i + 1}</span>
                                    <span style={{
                                        fontSize: 12, fontFamily: 'JetBrains Mono, monospace',
                                        color: getLineColor(line),
                                        whiteSpace: 'pre', paddingRight: 16,
                                    }}>{line}</span>
                                </div>
                            ))}
                        </pre>
                    )}
                </div>
            )}
        </div>
    )
}

function getLineColor(line) {
    const t = line.trim()
    if (t.startsWith('//')) return 'var(--color-muted)'
    if (/^(LOAD|FROM|JOIN|RESIDENT|CONCATENATE|DROP|LET|NOCONCATENATE|WHERE|GROUP BY|ORDER BY|LEFT JOIN|INNER JOIN|OUTER JOIN)/i.test(t)) return '#79c0ff'
    if (/^(IF|ELSE|THEN|END IF|WHILE|END WHILE|EXIT|NEXT|FOR)/i.test(t)) return '#a78bfa'
    if (/^\[.*\]:$/.test(t)) return '#f97316'
    return 'var(--color-text)'
}
