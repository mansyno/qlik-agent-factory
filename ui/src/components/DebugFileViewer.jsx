import React, { useState, useEffect } from 'react';
import { FileText, ChevronDown, ChevronRight, X } from 'lucide-react';

export default function DebugFileViewer() {
  const [files, setFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [content, setContent] = useState('');
  const [isOpen, setIsOpen] = useState(false);

  const fetchFiles = async () => {
    try {
      const res = await fetch('/api/debug-files');
      const data = await res.json();
      setFiles(data);
    } catch (e) {
      console.error('Failed to fetch debug files', e);
    }
  };

  useEffect(() => {
    fetchFiles();
    const interval = setInterval(fetchFiles, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleSelect = async (file) => {
    setSelectedFile(file);
    try {
      const res = await fetch(`/api/debug-files/${encodeURIComponent(file)}`);
      if (res.ok) {
        const text = await res.text();
        setContent(text);
      } else {
        setContent('Error loading file content');
      }
    } catch (e) {
      setContent('Error fetching file content');
    }
  };

  const cardStyle = {
    background: 'rgba(22,27,34,0.7)',
    backdropFilter: 'blur(10px)',
    border: '1px solid rgba(48,54,61,0.8)',
    borderRadius: 12,
    marginTop: 20,
    overflow: 'hidden'
  };

  const headerStyle = {
    padding: '12px 16px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    cursor: 'pointer',
    background: 'rgba(33,38,45,0.5)',
    borderBottom: isOpen ? '1px solid rgba(48,54,61,0.8)' : 'none'
  };

  const badgeStyle = {
    background: 'rgba(110,118,129,0.1)',
    color: '#8b949e',
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 10,
    border: '1px solid rgba(110,118,129,0.2)'
  };

  return (
    <div style={cardStyle}>
      <div style={headerStyle} onClick={() => setIsOpen(!isOpen)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {isOpen ? <ChevronDown size={16} color="#8b949e" /> : <ChevronRight size={16} color="#8b949e" />}
          <span style={{ fontSize: 13, fontWeight: 600, color: '#c9d1d9', letterSpacing: '0.02em' }}>LLM PROMPT & DEBUG FILES</span>
          <span style={badgeStyle}>{files.length} Files</span>
        </div>
      </div>

      {isOpen && (
        <div style={{ padding: 16 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: selectedFile ? 16 : 0 }}>
            {files.map(file => (
              <button
                key={file}
                onClick={() => handleSelect(file)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 12px',
                  borderRadius: 6,
                  background: selectedFile === file ? 'rgba(31,111,235,0.15)' : 'rgba(110,118,129,0.05)',
                  color: selectedFile === file ? '#58a6ff' : '#8b949e',
                  border: `1px solid ${selectedFile === file ? 'rgba(31,111,235,0.5)' : 'rgba(110,118,129,0.2)'}`,
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: 'pointer',
                  transition: 'all 0.1s'
                }}
              >
                <FileText size={14} />
                {file.replace('.debug_', '')}
              </button>
            ))}
          </div>

          {selectedFile && (
            <div style={{ position: 'relative', marginTop: 12 }}>
              <div style={{
                background: '#0d1117',
                border: '1px solid rgba(48,54,61,0.8)',
                borderRadius: 8,
                padding: 16,
                maxHeight: 500,
                overflowY: 'auto',
                fontFamily: 'SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
                fontSize: 12,
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                color: '#c9d1d9'
              }}>
                <button
                  onClick={() => setSelectedFile(null)}
                  style={{
                    position: 'absolute',
                    top: 8,
                    right: 8,
                    background: 'transparent',
                    border: 'none',
                    color: '#8b949e',
                    cursor: 'pointer'
                  }}
                >
                  <X size={16} />
                </button>
                {content}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
