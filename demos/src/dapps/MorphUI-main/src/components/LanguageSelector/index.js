import React, { useState } from 'react'
import { Image, Dropdown} from 'react-bootstrap';
import LanguageIcon from '../../assets/images/language-icon.svg';
import styles from "./languageSelector.module.css";

const Index = () => {
    const [dropdownVal, setDropdownVal] = useState("en");

    const handleClick = (e) => {
        setDropdownVal(e.target.innerText);
    }
    return (
        <Dropdown className={styles.languageSelector}>
            <Dropdown.Toggle id="dropdown-basic">
                <Image src={LanguageIcon} /> {dropdownVal}
            </Dropdown.Toggle>
            <Dropdown.Menu className={styles.dropdownMenu}>
                <div>
                    <Dropdown.Item onClick={handleClick}>DE</Dropdown.Item>
                    <Dropdown.Item onClick={handleClick}>FR</Dropdown.Item>
                    <Dropdown.Item onClick={handleClick}>RU</Dropdown.Item>
                    <Dropdown.Item onClick={handleClick}>ES</Dropdown.Item>
                    <Dropdown.Item onClick={handleClick}>IT</Dropdown.Item>
                    <Dropdown.Item onClick={handleClick}>PT</Dropdown.Item>
                </div>
            </Dropdown.Menu>
        </Dropdown>
    )
}

export default Index