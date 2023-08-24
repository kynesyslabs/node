import React from 'react'
import { Link } from 'react-router-dom';
import styles from "./customCard.module.css";

const Index = ({heading, description, linkText, linkUrl }) => {
  return (
    <div className={styles.cardWrap}>
      <div className={styles.cardInnerWrap}>
        <h3>{heading}</h3>
        <p>{description}</p>
        {linkText && <Link className='generalBtn' to={linkUrl}>{linkText}</Link>}
      </div>
    </div>
  )
}

export default Index