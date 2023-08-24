import Home from './pages/Home';
import Swap from './pages/Swap';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Header from './components/Header';
import Footer from './components/Footer';
import './App.css';

function App() {
  return (
    <div className="App">
      <BrowserRouter>
        <Header />
        <Routes>
            <Route exact path="/" element={<Home />} />
            <Route path="/swap" element={<Swap />} />
            {/* <Route path="/about" component={About} />
            <Route path="/contact" component={Contact} /> */}
        </Routes>
        <Footer />
      </BrowserRouter>
    </div>
  );
}

export default App;