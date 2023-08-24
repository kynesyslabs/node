import React from 'react'
import { Link } from 'react-router-dom';
import styles from './socialCard.module.css';

const Index = ({icon , name}) => {
  return (
    <div key={name} className={styles.engageCard}>
        <Link>
            {icon}
            <span>{name}</span>
        </Link>
    </div>
  )
}

export default Index