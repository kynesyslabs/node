import React from 'react'
import {Container,  Row, Col, Image, Form, Button} from 'react-bootstrap';
import logo from '../../assets/images/morph-icon.svg';
import styles from "./footer.module.css";
import { Link } from 'react-router-dom';
import LanguageSelector from '../../components/LanguageSelector';
import { TbExternalLink } from 'react-icons/tb';

const Index = () => {
  return (
    <div className={styles.footer}>
        <Container>
            <div className={styles.footerLinkWarp}>
                <Row className={styles.footerLinkRow}>
                    <Col md={6} lg={3} className={styles.footerLink}>
                        <h3>Explore</h3>
                        <ul>
                            <li><Link to="/">Trade</Link></li>
                            <li><Link to="/">Swap</Link></li>
                            <li><Link to="/">Stake</Link></li>
                            <li><Link to="/">NFTs</Link></li>
                            <li><Link to="/">Bridge</Link></li>
                            <li><Link to="/">Farming</Link></li>
                        </ul>
                    </Col>
                    <Col md={6} lg={3} className={styles.footerLink}>
                        <h3>Morph</h3>
                        <ul>
                            <li><Link to="/">Cloud</Link></li>
                            <li><Link to="/">Pay</Link></li>
                            <li><Link to="/">Locker</Link></li>
                            <li><Link to="/">Launchpad</Link></li>
                            <li><Link to="/">Messenger</Link></li>
                        </ul>
                    </Col>
                    <Col md={6} lg={3} className={styles.footerLink}>
                        <h3>About</h3>
                        <ul>
                            <li><Link to="/">Terms of Use</Link></li>
                            <li><Link to="/">Privacy Policy</Link></li>
                            <li><Link to="/">Careers</Link></li>
                        </ul>
                    </Col>
                    <Col md={6} lg={3} className={styles.footerLink}>
                        <h3>Support</h3>
                        <ul>
                            <li><Link to="/">Contact Us <TbExternalLink /></Link></li>
                            <li><Link to="/">Learn More <TbExternalLink /></Link></li>
                        </ul>
                    </Col>
                </Row>
            </div>
            <Row>
                <Col md={5} lg={4} xl={5} className={styles.footerLogoWrap}>
                    <Link to="/" className={styles.footerLogo}>
                        <Image src={logo} />
                    </Link>
                    <p>The everyday, decentralized,
                        easy-to-access hub for everyone</p>
                </Col>
                <Col md={7} lg={8} xl={7} className={styles.footerNewsUpdate}>
                    <p>Get the latest news and updates</p>
                    <Form className={styles.newsletterForm}>
                        <Form.Control
                            required
                            type="email"
                            placeholder="Your Email"
                        />
                        <Button type="submit">Send</Button>
                    </Form>
                </Col>
            </Row>
            
            <div className={styles.copyrightWrap}>
                <p>© 2022 - 2023 Morph.com. All rights reserved.</p>
                <LanguageSelector /> 
            </div>
        </Container>
    </div>
  )
}

export default Index