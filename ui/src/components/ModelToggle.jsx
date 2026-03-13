import React, { useState, useEffect } from 'react';
import { Sparkles, Zap, ChevronDown, Check } from 'lucide-react';

export default function ModelToggle() {
    const [activeModel, setActiveModel] = useState('');
    const [options, setOptions] = useState({});
    const [isOpen, setIsOpen] = useState(false);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchModel();
    }, []);

    const fetchModel = async () => {
        try {
            const res = await fetch('/api/model');
            const data = await res.json();
            setActiveModel(data.activeModel);
            setOptions(data.options);
            setLoading(false);
        } catch (err) {
            console.error('Failed to fetch model:', err);
        }
    };

    const handleSwitch = async (modelKey) => {
        const modelName = options[modelKey];
        try {
            await fetch('/api/model', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: modelName })
            });
            setActiveModel(modelName);
            setIsOpen(false);
        } catch (err) {
            console.error('Failed to switch model:', err);
        }
    };

    if (loading) return null;

    const currentKey = Object.keys(options).find(key => options[key] === activeModel) || 'primary';

    return (
        <div style={{ position: 'relative' }}>
            <button
                onClick={() => setIsOpen(!isOpen)}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 12px',
                    background: 'var(--color-surface2)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 6,
                    color: 'var(--color-text)',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                }}
                onMouseEnter={(e) => e.currentTarget.style.borderColor = 'var(--color-muted)'}
                onMouseLeave={(e) => e.currentTarget.style.borderColor = 'var(--color-border)'}
            >
                {currentKey === 'primary' ? (
                    <Sparkles size={14} color="#8b5cf6" />
                ) : (
                    <Zap size={14} color="#d29922" />
                )}
                <span>{currentKey.toUpperCase()}</span>
                <ChevronDown size={14} style={{ 
                    transform: isOpen ? 'rotate(180deg)' : 'none',
                    transition: 'transform 0.2s',
                    opacity: 0.5
                }} />
            </button>

            {isOpen && (
                <>
                    <div 
                        onClick={() => setIsOpen(false)}
                        style={{ position: 'fixed', inset: 0, zIndex: 100 }} 
                    />
                    <div style={{
                        position: 'absolute',
                        top: 'calc(100% + 8px)',
                        right: 0,
                        width: 220,
                        background: 'var(--color-surface)',
                        border: '1px solid var(--color-border)',
                        borderRadius: 8,
                        boxShadow: '0 10px 25px rgba(0,0,0,0.3)',
                        padding: 6,
                        zIndex: 101,
                        animation: 'fadeIn 0.2s ease-out'
                    }}>
                        {Object.keys(options).map((key) => {
                            const isSelected = options[key] === activeModel;
                            return (
                                <button
                                    key={key}
                                    onClick={() => handleSwitch(key)}
                                    style={{
                                        width: '100%',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        gap: 10,
                                        padding: '10px 12px',
                                        background: isSelected ? 'rgba(47,129,247,0.1)' : 'transparent',
                                        border: 'none',
                                        borderRadius: 6,
                                        color: isSelected ? 'var(--color-accent)' : 'var(--color-text)',
                                        fontSize: 13,
                                        fontWeight: 500,
                                        cursor: 'pointer',
                                        textAlign: 'left',
                                        transition: 'all 0.1s'
                                    }}
                                    onMouseEnter={(e) => {
                                        if (!isSelected) e.currentTarget.style.background = 'var(--color-surface2)';
                                    }}
                                    onMouseLeave={(e) => {
                                        if (!isSelected) e.currentTarget.style.background = 'transparent';
                                    }}
                                >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                        {key === 'primary' ? <Sparkles size={14} /> : <Zap size={14} />}
                                        <div>
                                            <div style={{ fontWeight: 600 }}>{key.charAt(0).toUpperCase() + key.slice(1)}</div>
                                            <div style={{ fontSize: 10, opacity: 0.6 }}>{options[key]}</div>
                                        </div>
                                    </div>
                                    {isSelected && <Check size={14} />}
                                </button>
                            );
                        })}
                        <div style={{ 
                            marginTop: 4, 
                            padding: '8px 12px', 
                            fontSize: 10, 
                            color: 'var(--color-muted)',
                            borderTop: '1px solid var(--color-border)' 
                        }}>
                            Lower versions use less quota but may be less accurate.
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
