// Escolha de microfone, câmera e saída de áudio ("Padrão do sistema" e a lista do navegador). Na tela de entrada
// a escolha reabre a prévia; na chamada, troca o aparelho sem sair dela.
import { useEffect, useState } from 'react';
import { canPickOutput, deviceLabel, listDevices, loadChoice, mediaKindOf, saveChoice, type DeviceKind, type DeviceLists } from '../../lib/call/devices';
import { switchDevice } from '../../lib/call/store';
import { Icon, type IconName } from '../Icon';
import { Menu } from '../ui';

const TITLE: Record<DeviceKind, string> = { mic: 'Microfone', cam: 'Câmera', out: 'Saída de áudio' };
const ICON: Record<DeviceKind, IconName> = { mic: 'mic', cam: 'cam', out: 'call-speaker' };

export function useDeviceLists(refreshKey?: unknown) {
  const [lists, setLists] = useState<DeviceLists>({ mic: [], cam: [], out: [] });
  useEffect(() => {
    let alive = true;
    const load = () => void listDevices().then((l) => alive && setLists(l));
    load();
    navigator.mediaDevices?.addEventListener?.('devicechange', load);
    return () => {
      alive = false;
      navigator.mediaDevices?.removeEventListener?.('devicechange', load);
    };
  }, [refreshKey]);
  return lists;
}

export function DeviceMenu({ inCall, onPick, refreshKey, only }: { inCall?: boolean; onPick?: (kind: DeviceKind, id: string) => void; refreshKey?: unknown; only?: DeviceKind[] }) {
  const lists = useDeviceLists(refreshKey);
  const [choice, setChoice] = useState<Record<DeviceKind, string>>(() => ({ mic: loadChoice('mic'), cam: loadChoice('cam'), out: loadChoice('out') }));
  const kinds = (only ?? (['mic', 'cam', 'out'] as DeviceKind[])).filter((k) => k !== 'out' || canPickOutput());
  const pick = (kind: DeviceKind, id: string) => {
    saveChoice(kind, id);
    setChoice((c) => ({ ...c, [kind]: id }));
    if (inCall) void switchDevice(mediaKindOf(kind), id);
    onPick?.(kind, id);
  };
  return (
    <div className="call-devices">
      {kinds.map((kind) => {
        const list = lists[kind];
        const id = choice[kind] && list.some((d) => d.deviceId === choice[kind]) ? choice[kind] : '';
        const i = list.findIndex((d) => d.deviceId === id);
        const current = i >= 0 ? deviceLabel(list[i], i, kind) : 'Padrão do sistema';
        return (
          <div key={kind} className="call-device">
            <span className="call-device-label" id={`call-device-${kind}`}>
              {TITLE[kind]}
            </span>
            <Menu
              align="left"
              label={TITLE[kind]}
              sheetTitle={TITLE[kind]}
              className="call-device-menu"
              trigger={
                <button type="button" className="btn call-device-btn" title={current} aria-labelledby={`call-device-${kind} call-device-${kind}-v`}>
                  <Icon name={ICON[kind]} />
                  <span className="ellipsis" id={`call-device-${kind}-v`}>
                    {current}
                  </span>
                  <Icon name="chevron-down" className="call-device-caret" />
                </button>
              }
            >
              {(close) => (
                <>
                  <button type="button" role="menuitemradio" aria-checked={!id} onClick={() => (close(), pick(kind, ''))}>
                    Padrão do sistema
                    {!id && <Icon name="check" className="menu-check" />}
                  </button>
                  {list.map((d, n) => (
                    <button key={d.deviceId} type="button" role="menuitemradio" aria-checked={d.deviceId === id} onClick={() => (close(), pick(kind, d.deviceId))}>
                      <span className="ellipsis">{deviceLabel(d, n, kind)}</span>
                      {d.deviceId === id && <Icon name="check" className="menu-check" />}
                    </button>
                  ))}
                </>
              )}
            </Menu>
          </div>
        );
      })}
    </div>
  );
}
