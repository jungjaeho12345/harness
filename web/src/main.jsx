import { createRoot } from 'react-dom/client';
import { createHttpModel } from './model/httpModel.js';

// 합성 루트 — 실제 REST/SSE 배선(httpModel)을 만들어 App에 주입한다(ADR-003 주입형 Model 계약).
// App/라우팅은 step10에서 완성된다. 지금은 placeholder가 model prop을 받는 형태만 갖춘다.
function App({ model }) {
  return <h1 data-model-injected={String(Boolean(model))}>기사 작성기</h1>;
}

const model = createHttpModel();
createRoot(document.getElementById('root')).render(<App model={model} />);
