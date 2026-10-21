import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export function QrCode({ text, size = 200 }: { text: string; size?: number }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    void QRCode.toDataURL(text, { width: size, margin: 1 }).then(setSrc);
  }, [text, size]);
  return src ? <img className="qr" src={src} width={size} height={size} alt="QR code" /> : null;
}
