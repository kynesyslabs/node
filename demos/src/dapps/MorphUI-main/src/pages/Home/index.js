import React, { useState } from 'react';
import CustomTabs from '../../components/CustomTabs';
import CustomCard from '../../components/CustomCard';
import styles from "./home.module.css";
import { Container, Row, Col, Form, Button, Image } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import SocialCard from '../../components/SocialCard';
import { FaDiscord, FaTwitter, FaYoutube, FaTelegramPlane, FaGithub } from 'react-icons/fa';
import { BiSearch } from 'react-icons/bi';
import { BsPlayFill } from 'react-icons/bs';
import SliderIcon from "../../assets/images/sliderIcon.svg"
import QRCode from "../../assets/images/qr-code.png"
import IOSIcon from "../../assets/images/iosIcon.svg"
import AndroidIcon from "../../assets/images/androidIcon.svg"
import TokensImg from "../../assets/images/tokens-img.png"
import EllipsesImg from "../../assets/images/ellipsesImg.png"
import BannerVideo from "../../assets/videos/kynesysVideo.mp4"
import Lottie from 'lottie-react';
import animationData from '../../assets/json/tokensAnimation.json';

const engagedOption = [{
  engagedIcon: <FaDiscord />,
  engagedIconName: "Discord",
}, {
  engagedIcon: <FaTwitter />,
  engagedIconName: "Twitter",
}, {
  engagedIcon: <FaYoutube />,
  engagedIconName: "YouTube",
}, {
  engagedIcon: <FaTelegramPlane />,
  engagedIconName: "Telegram",
}, {
  engagedIcon: <FaGithub />,
  engagedIconName: "FaGithub",
}]

const Index = () => {
  const [cookies, setCookies] = useState(true);
  return (
    <>
      {cookies && 
      <div className={styles.cookiesCardWrap}>
        <div className={styles.cookiesCard}>
          <p>Yes, we use <Link to="/">cookies</Link>. Otherwise, nothing’s going to work. In the meantime, you can read our <Link to="/">Privacy policy.</Link></p>
          <Button type="button" className='generalBtn' onClick={() => {setCookies(false)}}>Accept</Button>
        </div>
      </div>}
      <div className={styles.banner}>
        <video autoPlay muted loop className={styles.bannerVideo}>
          <source src={BannerVideo}
            type="video/mp4"></source>
        </video>
        <Container>
          <CustomTabs />
          <Form className={styles.searchToken}>
            <BiSearch />
            <Form.Control
              required
              type="text"
              placeholder="Search tokens and NFT collections"
            />
            <Button type="submit">
              <Image src={SliderIcon} />
            </Button>
          </Form>
          <h2>Seamless Transactions.
            Secure Trading and Swapping.</h2>
          <Link className='transparentBtn'>Start now</Link>
          <Button type='button' className={styles.playBtn}>
            <BsPlayFill />
          </Button>
          <Row>
            <Col lg={6} className={styles.customCardCol}>
              <CustomCard
                heading="Stake Tokens"
                description="Maximize your DeFi earnings by staking tokens on various blockchains"
                linkText="Stake"
                linkUrl="/"
              />
            </Col>
            <Col lg={6} className={styles.customCardCol}>
              <CustomCard
                heading="Earn Profits"
                description="Start earning swap fees by providing liquidity today"
                linkText="Connect wallet"
                linkUrl="/"
              />
            </Col>
          </Row>
        </Container>
      </div>
      <div className={styles.chainSupportWrap}>
        <Container>
          <div className={styles.chainSupportContent}>
            <h2>Extensive Chain Support</h2>
            <p>Discover the broadest range of supported chains, ensuring compatibility with your favorite cryptocurrencies</p>
            <div className={styles.invertTradeEarnWrap}>
              <div className={styles.lottie}>
                <Lottie
                  animationData={animationData}
                  loop={true}
                  autoplay={true}
                  width="100%"
                />
              </div>
              <div className={styles.invertTradeEarn}>
                <div className={styles.downloadMorph}>
                  <h2>Invest. Trade. Earn</h2>
                  <h3>Download Morph App</h3>
                </div>
                <div className={styles.downloadIcons}>
                  <Link to="/" className={styles.downloadLink}><Image src={IOSIcon} /></Link>
                  <Link to="/" className={styles.downloadLink}><Image src={AndroidIcon} /></Link>
                </div>
                <div className={styles.downloadAppCardWrap}>
                  <div className={styles.downloadAppCard}>
                    <Image src={QRCode} className={styles.qrCode} />
                    <div className={styles.downloadApp}>
                      <h6>Download App</h6>
                      <span>Scan a QR code</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className={styles.supportTrust}>
              <h2>Support and trust over 30,000 traders</h2>
              <Link to="/" className='transparentBtn'>Get Started</Link>
            </div>
          </div>
        </Container>
      </div>
      <div className={styles.ecosystemProductWrap}>
        <Container>
          <div className={styles.ecosystemProductContent}>
            <Row className={styles.socialSecRow}>
              <Col lg={6} className={styles.customCardCol}>
                <CustomCard
                  heading="Swap Tokens"
                  description="Swap your tokens and explore new investment possibilities"
                  linkText="Stake"
                  linkUrl="/"
                />
              </Col>
              <Col lg={6} className={styles.customCardCol}>
                <CustomCard
                  heading="Trade NFT's"
                  description="Connect, trade, and build your digital art empire with ease"
                  linkText="Trade"
                  linkUrl="/"
                />
              </Col>
            </Row>
            <h2>Learn more ecosystem product
              at Kynesys Labs — Morph</h2>
            <Link className='transparentBtn'>Learn more</Link>
            <h3>Get part of an active and engaged community</h3>
            <div className={styles.socialCardRow}>
              {engagedOption.map(item => (
                <SocialCard
                  key={item.engagedIconName}
                  icon={item.engagedIcon}
                  name={item.engagedIconName}
                />
              ))}
            </div>
          </div>
        </Container>
      </div>
    </>
  )
}

export default Index