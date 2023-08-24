import React, { useState } from 'react';
import {Container, Nav, Navbar, Image} from 'react-bootstrap';
import { FaBars } from 'react-icons/fa'
import styles from "./header.module.css";
import logo from '../../assets/images/morph-icon.svg';
import chainIcon from '../../assets/images/morph-chain-icon.svg';
import LanguageSelector from '../../components/LanguageSelector';
import { Link } from 'react-router-dom';

const Index = () => {
  const [showDropdown, setShowDropdown] = useState(true);
  return (
    <div expand="xl" className={styles.header}>
      <Container>
      <Navbar expand="xl" className={styles.navbar}>
        <Navbar.Brand href="/" className={styles.navbarBrand}>
            <Image className={styles.navbarBrandLogo} src={logo} />
        </Navbar.Brand>
        <Navbar.Toggle aria-controls="basic-navbar-nav" className={styles.NavbarToggle} >
          <FaBars />
        </Navbar.Toggle>
        <Navbar.Collapse id="basic-navbar-nav" className={styles.NavbarCollapse}>
          <Nav className={styles.NavbarNav}>
            <Nav.Link href="#home">Cloud</Nav.Link>
            <Nav.Link href="#link">Pay</Nav.Link>
            <Nav.Link href="#home">Locker</Nav.Link>
            <Nav.Link href="#link">Launchpad</Nav.Link>
            <Nav.Link href="#link">Messenger</Nav.Link>
          </Nav>
        </Navbar.Collapse>
          <div className={styles.languageWrap}>
            <Link to="" className={styles.chainBtn}>
                <Image src={chainIcon} />
            </Link>
            <Link to="" className={styles.connentBtn}>
                {showDropdown ? "Connect wallet" : "Connented"}
            </Link>
            <LanguageSelector />
          </div>
        </Navbar>
      </Container>
    </div>
  )
}

export default Index