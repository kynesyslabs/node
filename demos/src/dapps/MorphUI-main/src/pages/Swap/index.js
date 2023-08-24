import React, {useState} from 'react';
import CustomTabs from '../../components/CustomTabs';
import styles from "./swap.module.css";
import { Container, Button, Row, Col, Image } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { MdOutlineInfo } from 'react-icons/md';
import BNBIcon from '../../assets/images/bnb-icon.png';
import EthereumIcon from '../../assets/images/ethereum-icon.png';
import DownUpArrow from '../../assets/images/arrow_Down_Up-icon.svg';
import SellBuyCard from '../../components/SellBuyCard';
import SelectPopup from '../../components/SelectPopup';
import { RxChevronDown, RxChevronRight } from 'react-icons/rx';
import { HiOutlineExternalLink } from 'react-icons/hi';
import TokenImg1 from "../../assets/images/tokenImg1.png"
import TokenImg2 from "../../assets/images/tokenImg2.png"
import TokenImg3 from "../../assets/images/tokenImg3.png"
import TokenImg4 from "../../assets/images/tokenImg4.png"
import TokenImg5 from "../../assets/images/tokenImg5.png"
import TokenImg6 from "../../assets/images/tokenImg6.png"
import TokenImg7 from "../../assets/images/tokenImg7.png"
import TokenImg8 from "../../assets/images/tokenImg8.png"
import TokenImg9 from "../../assets/images/tokenImg9.png"
import TokenImg10 from "../../assets/images/tokenImg10.png"

const sell = [{
  title: "Ether",
  subtotal: "~$2 505.29"
}]

const buy = [{
  title: "Ether",
  subtotal: "~$1 179.87",
  negativePercentage: "-53.07"
}]

const commonToken = [{
  tokenId: "1",
  tokenTitle: "ETH",
  tokenImg: TokenImg1,
},{
  tokenId: "2",
  tokenTitle: "1INCH",
  tokenImg: TokenImg2,
},{
  tokenId: "3",
  tokenTitle: "WBTC",
  tokenImg: TokenImg3,
},{
  tokenId: "4",
  tokenTitle: "WETH",
  tokenImg: TokenImg4,
},{
  tokenId: "5",
  tokenTitle: "DAI",
  tokenImg: TokenImg5,
},{
  tokenId: "6",
  tokenTitle: "USDC",
  tokenImg: TokenImg6,
},{
  tokenId: "7",
  tokenTitle: "USDT",
  tokenImg: TokenImg7,
},{
  tokenId: "8",
  tokenTitle: "SHIBA INU",
  tokenImg: TokenImg8,
},{
  tokenId: "9",
  tokenTitle: "Binance USD",
  tokenImg: TokenImg9,
}]

const tokens = [{
  id: "1",
  name: "Ether",
  img: TokenImg1,
  shortName: "ETH",
  totalToken: 0,
},{
  id: "2",
  name: "Tether USD",
  img: TokenImg7,
  shortName: "USDT",
  totalToken: 0,
},{
  id: "3",
  name: "USD Coin",
  img: TokenImg6,
  shortName: "USDC",
  totalToken: 0,
},{
  id: "4",
  name: "Binance USD",
  img: TokenImg9,
  shortName: "BUSD",
  totalToken: 0,
},{
  id: "5",
  name: "Matic Token",
  img: TokenImg10,
  shortName: "MATIC",
  totalToken: 0,
}]

const Index = () => {
  const [swapMode, setSwapMode] = useState(false);
  const [inverse, setInverse] = useState(false);
  const [modalPopup, setModalPopup] = useState(false);
  const [checkClicked, setCheckClicked] = useState("");
  const [buyToken, setBuyToken] = useState({ icon: EthereumIcon, label: 'BNB Chain' });
  const [sellToken, setSellToken] = useState({ icon: BNBIcon, label: 'Ethereum Mainnet' });

  return (
    <>
      <div className={styles.bannerSwap}>
        <Container>
          <CustomTabs />
          {modalPopup ? 
          <SelectPopup 
            popupHeading= "Select a token"
            tokenTitle = "Common tokens"
            commonToken = {commonToken}
            tokens = {tokens}
            modalPopup = {modalPopup}
            setModalPopup = {setModalPopup}
            checkClicked = {checkClicked}
            buyToken = {buyToken}
            setBuyToken = {setBuyToken}
            sellToken = {sellToken}
            setSellToken = {setSellToken}
          /> :
          <div className={styles.swapCard}>
            <div className={inverse ? "" : styles.inverseOrder}> 
              <SellBuyCard 
                headingLabel = "You sell"
                heading = {sellToken.label}
                headingIcon = {sellToken.icon}
                settings = {true}
                cardHeading = "Sell"
                cardTotal = "1.342059"
                cardDescription = {sell}
                modalPopup = {modalPopup}
                setModalPopup = {setModalPopup}
                setCheckClicked = {setCheckClicked}
                clickedDropdown = "sell"
              />
              <Button type="button" className={styles.exchangeBtn} onClick={() => setInverse(!inverse)}>
                <Image src={DownUpArrow} />
              </Button>
              <SellBuyCard 
                headingLabel = "You buy"
                heading = {buyToken.label}
                headingIcon = {buyToken.icon}
                settings = {false}
                cardHeading = "Buy"
                cardTotal = "2.399586"
                cardDescription = {buy}
                modalPopup = {modalPopup}
                setModalPopup = {setModalPopup}
                setCheckClicked = {setCheckClicked}
                clickedDropdown = "buy"
              />
            </div>
            {swapMode ? 
              <div className={styles.swapModeCardWrap}>
                <div className={styles.swapModeCard}>
                  <div className={styles.swapModeHeading}>
                    <h6>Swap mode</h6>
                    <Button type='button' onClick={() => setSwapMode(!swapMode)}><RxChevronRight /></Button>
                  </div>
                  <Row className={styles.swapRow}>
                    <Col sm={6} className={styles.swapCol}>
                      <div className={styles.fusionModeCard}>
                        <div className={styles.fusionMode}>
                          <div className={styles.fusionModeHeading}>
                            <h5>Fusion</h5>
                            <span>Auto</span>
                          </div>
                          <ul>
                            <li><p>Settlement Fee</p> <span>~$8.36</span></li>
                          </ul>
                        </div>
                      </div>
                    </Col>
                    <Col sm={6} className={styles.swapCol}>
                      <div className={styles.fusionModeCard}>
                        <div className={styles.fusionMode}>
                        <div className={styles.fusionModeHeading}>
                            <h5>Fusion</h5>
                            <span>Auto</span>
                          </div>
                          <ul>
                            <li><p>Settlement Fee</p> <span>~$8.36</span></li>
                          </ul>
                        </div>
                      </div>
                    </Col>
                    <Col sm={12} className={styles.swapCol}>
                      <div className={styles.modeOfferCard}>
                        <div className={styles.modeOffer}>
                          <p>Fusion mode offers fast execution and front-running protection without the cost of gas fees.</p>
                          <Link to="/">Learn More <HiOutlineExternalLink /></Link>
                        </div>
                      </div>
                    </Col>
                  </Row>
                  <ul className={styles.networkFree}>
                    <li><p>Network Fee</p><p className={styles.greenClr}>Free</p></li>
                    <li><p>Settlement Fee</p><p>~$8.36451749<span>8.35788986</span><span>DAI</span></p></li>
                    <li><p>Est. WETH sell price</p><p>~$1 955.52<span>1953.97</span><span>DAI</span></p></li>
                    <li><p>Min WETH sell price</p><p>~$1 922.46<span>1920.93</span><span>DAI</span></p></li>
                  </ul>
                </div>
              </div> :
              <div className={styles.infoContent}>
                  <p><MdOutlineInfo/> 1 WETH = 1943.52 DAI <span>(~$1 946.8)</span></p>
                  <Button type="button" onClick={() => setSwapMode(!swapMode)}>~$3.5 <RxChevronDown /></Button>
              </div>
            }
            
            <div className={styles.priceImpact}>
              <p>High price impact! More than 53.07% drop!</p>
            </div>
            <div className={styles.swapCardBtn}>
              <Button type='button' className={styles.generalBtn}>Connect wallet</Button>
              <Link to="/" className={styles.learnMoreBtn}>Learn More <HiOutlineExternalLink /></Link>
            </div>
          </div>
        }
        </Container>
      </div>
    </>
  )
}

export default Index