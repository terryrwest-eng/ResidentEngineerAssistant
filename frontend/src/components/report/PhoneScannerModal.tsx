/**
 * Daily Reporter V3 — Phone Scanner Modal (Camera Capture)
 *
 * Ported from V1 PhoneScannerModal.jsx — same UX:
 * - Opens device camera via navigator.mediaDevices.getUserMedia
 * - On phone browser → uses phone camera natively
 * - On desktop → uses webcam (or Windows Phone Link camera if available)
 * - Capture button draws video frame to canvas → JPEG blob → File
 * - Flip camera (front/back) toggle
 * - Take multiple photos, review thumbnails
 * - "Done" returns File[] to parent via onCapturedImages callback
 *
 * This is NOT a QR-code/pairing flow. It's pure browser camera API.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { X, Camera, RotateCcw, Check, Loader2 } from 'lucide-react';

interface PhoneScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCapturedImages: (files: File[]) => void;
}

type CameraStatus = 'initializing' | 'active' | 'error';

export function PhoneScannerModal({
  isOpen,
  onClose,
  onCapturedImages,
}: PhoneScannerModalProps) {
  const [status, setStatus] = useState<CameraStatus>('initializing');
  const [errorMsg, setErrorMsg] = useState('');
  const [capturedImages, setCapturedImages] = useState<{ url: string; file: File }[]>([]);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [showFlash, setShowFlash] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // --- Start camera ---
  const startCamera = useCallback(async (facing: 'environment' | 'user') => {
    setStatus('initializing');
    setErrorMsg('');

    // Stop any existing stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      setStatus('active');
      console.debug('[PhoneScanner] Camera started, facing:', facing);
    } catch (err) {
      console.error('[PhoneScanner] Camera error:', err);
      setStatus('error');
      const error = err as Error;
      if (error.name === 'NotAllowedError') {
        setErrorMsg('Camera permission denied. Please allow camera access in your browser settings.');
      } else if (error.name === 'NotFoundError') {
        setErrorMsg('No camera found on this device.');
      } else {
        setErrorMsg(`Camera error: ${error.message}`);
      }
    }
  }, []);

  // --- Initialize camera on open ---
  useEffect(() => {
    if (isOpen) {
      startCamera(facingMode);
    }

    return () => {
      // Cleanup on close
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // --- Flip camera ---
  const handleFlipCamera = useCallback(() => {
    const newFacing = facingMode === 'environment' ? 'user' : 'environment';
    setFacingMode(newFacing);
    startCamera(newFacing);
  }, [facingMode, startCamera]);

  // --- Capture photo ---
  const handleCapture = useCallback(() => {
    if (!videoRef.current || !canvasRef.current || status !== 'active') return;

    const video = videoRef.current;
    const canvas = canvasRef.current;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0);

    // Flash effect
    setShowFlash(true);
    setTimeout(() => setShowFlash(false), 200);

    canvas.toBlob(
      (blob) => {
        if (!blob) return;

        const timestamp = Date.now();
        const file = new File([blob], `camera_capture_${timestamp}.jpg`, {
          type: 'image/jpeg',
        });

        const url = URL.createObjectURL(blob);
        setCapturedImages((prev) => [...prev, { url, file }]);
        console.debug('[PhoneScanner] Captured image:', file.name, file.size, 'bytes');
      },
      'image/jpeg',
      0.92
    );
  }, [status]);

  // --- Remove a captured image ---
  const removeImage = useCallback((idx: number) => {
    setCapturedImages((prev) => {
      const updated = [...prev];
      URL.revokeObjectURL(updated[idx].url);
      updated.splice(idx, 1);
      return updated;
    });
  }, []);

  // --- Done — send files to parent ---
  const handleDone = useCallback(() => {
    const files = capturedImages.map((img) => img.file);
    onCapturedImages(files);

    // Cleanup
    capturedImages.forEach((img) => URL.revokeObjectURL(img.url));
    setCapturedImages([]);
    onClose();
  }, [capturedImages, onCapturedImages, onClose]);

  // --- Close and cleanup ---
  const handleClose = useCallback(() => {
    capturedImages.forEach((img) => URL.revokeObjectURL(img.url));
    setCapturedImages([]);
    onClose();
  }, [capturedImages, onClose]);

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.85)',
        backdropFilter: 'blur(8px)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          background: 'var(--color-surface, #fff)',
          borderRadius: '16px',
          border: '1px solid var(--color-border)',
          width: '90vw',
          maxWidth: '640px',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.3)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 18px',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              fontWeight: 600,
              fontSize: '0.9375rem',
              color: 'var(--color-text-primary)',
            }}
          >
            <Camera size={18} />
            Document Scanner
          </div>
          <button
            onClick={handleClose}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '34px',
              height: '34px',
              borderRadius: '8px',
              border: 'none',
              background: 'var(--color-surface-hover, rgba(0,0,0,0.04))',
              color: 'var(--color-text-tertiary)',
              cursor: 'pointer',
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '14px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            position: 'relative',
          }}
        >
          {/* Status */}
          {status === 'initializing' && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 14px',
                borderRadius: '10px',
                fontSize: '0.85rem',
                fontWeight: 500,
                background: 'rgba(234, 179, 8, 0.08)',
                color: 'var(--color-warning)',
                border: '1px solid rgba(234, 179, 8, 0.15)',
              }}
            >
              <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} />
              Starting camera...
            </div>
          )}

          {status === 'error' && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 14px',
                borderRadius: '10px',
                fontSize: '0.85rem',
                fontWeight: 500,
                background: 'rgba(239, 68, 68, 0.08)',
                color: 'var(--color-danger)',
                border: '1px solid rgba(239, 68, 68, 0.15)',
              }}
            >
              {errorMsg}
            </div>
          )}

          {/* Video */}
          <div
            style={{
              position: 'relative',
              width: '100%',
              aspectRatio: '16 / 10',
              borderRadius: '12px',
              overflow: 'hidden',
              background: '#000',
              border: '1px solid var(--color-border)',
            }}
          >
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
              }}
            />

            {/* Capture flash */}
            {showFlash && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'white',
                  opacity: 0.7,
                  pointerEvents: 'none',
                  zIndex: 10,
                  animation: 'flash-fade 200ms ease-out forwards',
                }}
              />
            )}

            {/* Flip camera button */}
            {status === 'active' && (
              <button
                onClick={handleFlipCamera}
                style={{
                  position: 'absolute',
                  top: 'calc(50% - 22px)',
                  right: '16px',
                  zIndex: 20,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '44px',
                  height: '44px',
                  borderRadius: '50%',
                  border: 'none',
                  background: 'rgba(0, 0, 0, 0.5)',
                  backdropFilter: 'blur(8px)',
                  color: '#fff',
                  cursor: 'pointer',
                  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
                }}
                title="Flip camera"
              >
                <RotateCcw size={20} />
              </button>
            )}

            {/* Waiting state */}
            {status !== 'active' && status !== 'error' && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  textAlign: 'center',
                  padding: '32px 20px',
                  gap: '8px',
                  color: '#aaa',
                }}
              >
                <Camera size={36} />
                <h3
                  style={{
                    fontSize: '1rem',
                    fontWeight: 600,
                    color: '#fff',
                    margin: 0,
                  }}
                >
                  Initializing Camera
                </h3>
                <p style={{ fontSize: '0.85rem', opacity: 0.8, margin: 0, maxWidth: '260px' }}>
                  Point your camera at a timesheet, ticket, or handwritten notes.
                </p>
              </div>
            )}
          </div>

          {/* Hidden canvas for capture */}
          <canvas ref={canvasRef} style={{ display: 'none' }} />

          {/* Captured images */}
          {capturedImages.length > 0 && (
            <div>
              <h4
                style={{
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  color: 'var(--color-text-secondary)',
                  marginBottom: '6px',
                }}
              >
                Captured ({capturedImages.length})
              </h4>
              <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', padding: '4px 0' }}>
                {capturedImages.map((img, idx) => (
                  <div
                    key={idx}
                    style={{
                      position: 'relative',
                      width: '68px',
                      height: '68px',
                      borderRadius: '8px',
                      overflow: 'hidden',
                      flexShrink: 0,
                      border: '2px solid var(--color-border)',
                    }}
                  >
                    <img
                      src={img.url}
                      alt={`Captured ${idx + 1}`}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                    <button
                      onClick={() => removeImage(idx)}
                      style={{
                        position: 'absolute',
                        top: '2px',
                        right: '2px',
                        width: '18px',
                        height: '18px',
                        borderRadius: '50%',
                        border: 'none',
                        background: 'rgba(239, 68, 68, 0.85)',
                        color: '#fff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        fontSize: '10px',
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            padding: '14px 18px',
            borderTop: '1px solid var(--color-border)',
          }}
        >
          <button
            onClick={handleCapture}
            disabled={status !== 'active'}
            className="btn btn-primary"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '10px 24px',
              borderRadius: '12px',
              fontWeight: 600,
              opacity: status !== 'active' ? 0.4 : 1,
              cursor: status !== 'active' ? 'not-allowed' : 'pointer',
            }}
          >
            <Camera size={18} />
            Capture
          </button>

          {capturedImages.length > 0 && (
            <button
              onClick={handleDone}
              className="btn"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '10px 24px',
                borderRadius: '12px',
                fontWeight: 600,
                background: 'rgba(34, 197, 94, 0.1)',
                color: 'var(--color-success)',
                border: '1px solid rgba(34, 197, 94, 0.25)',
                cursor: 'pointer',
              }}
            >
              <Check size={18} />
              Done ({capturedImages.length})
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
