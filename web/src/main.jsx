import { createRoot } from 'react-dom/client';
import { createHttpModel } from './model/httpModel.js';
import App from './app/App.jsx';
import './styles/yonhap.css';

// 합성 루트 — 실제 REST/SSE 배선(httpModel)을 만들어 App에 주입한다(ADR-003 주입형 Model 계약).
const model = createHttpModel();
createRoot(document.getElementById('root')).render(<App model={model} />);
