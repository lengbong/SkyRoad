import { useState } from 'react';
import { FirstGuide, hasSeenGuide } from './components/FirstGuide';
import { AirlineApp } from './games/airline/AirlineApp';
import { AIRLINE_GUIDE } from './games/guides';

/** 안내를 봤는지 기억하는 이름 (예전 ‘우리 가족 보드게임’에서 본 기록도 그대로 쓴다) */
const GUIDE_ID = 'airline';

/** 하늘길 항공사 한 게임만 띄운다. 처음 열면 안내 3장을 보여 주고, ❓로 다시 볼 수 있다 */
export function App() {
  const [guide, setGuide] = useState(() => !hasSeenGuide(GUIDE_ID));
  return (
    <main className="app">
      <AirlineApp />
      <button type="button" className="guide-open" onClick={() => setGuide(true)} aria-label="놀이 방법 보기" title="놀이 방법 보기" data-testid="guide-open">
        ❓
      </button>
      {guide && <FirstGuide gameId={GUIDE_ID} title="하늘길 항공사" steps={AIRLINE_GUIDE} onClose={() => setGuide(false)} />}
    </main>
  );
}
