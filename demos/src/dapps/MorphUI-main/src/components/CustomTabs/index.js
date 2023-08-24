import React from 'react'
import styles from "./customTabs.module.css";
import { Link, useLocation } from 'react-router-dom';

const Index = () => {
  const location = useLocation();

  return (
    <div className={styles.linkListWrap}>
      <ul className={styles.linkList}>
        <li><Link to="/" >Trade</Link></li>
        <li><Link to="/swap" className={location.pathname === "/swap" && styles.activeTab}>Swap</Link></li>
        <li><Link to="/" >Stake</Link></li>
        <li><Link to="/" >NFTs</Link></li>
        <li><Link to="/" >Bridge</Link></li>
        <li><Link to="/" >Farming</Link></li>
      </ul>
    </div>
  )
}

export default Index