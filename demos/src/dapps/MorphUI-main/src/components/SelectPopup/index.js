import React from 'react'
import { Image, Button, Form } from 'react-bootstrap';
import styles from "./selectPopup.module.css";
import { IoClose } from 'react-icons/io5';
import { BiSearch } from 'react-icons/bi';
import SliderIcon from "../../assets/images/sliderIcon.svg"
import { AiOutlinePaperClip } from 'react-icons/ai';
import { HiOutlineExternalLink } from 'react-icons/hi';
import { Link } from 'react-router-dom';

const Index = ({popupHeading, tokenTitle, commonToken, tokens, modalPopup, setModalPopup, checkClicked, buyToken, setBuyToken, sellToken, setSellToken}) => {
    
    const handleClick = (icon, label) => {
        if(checkClicked === "sell") {
            setSellToken({ icon, label })
            setModalPopup(!modalPopup)
        }
        if(checkClicked === "buy") {
            setBuyToken({ icon, label })
            setModalPopup(!modalPopup)
        }
    }
    
    return (
        <div className={styles.selectCard}>
            <Form className={styles.selectCardInner}>
                <div className={styles.selectCardHeading}>
                    <h6>{popupHeading}</h6>
                    <Button className={styles.closeBtn} onClick={()=>setModalPopup(!modalPopup)}>
                        <IoClose />
                    </Button>
                </div>
                <div className={styles.searchTokenWrap}>
                    <div className={styles.searchToken}>
                        <BiSearch />
                        <Form.Control
                            required
                            type="text"
                            placeholder="Search tokens and NFT collections"
                        />
                        <Button type="submit">
                            <Image src={SliderIcon} />
                        </Button>
                    </div>
                </div>
                {/* { && <p></p>} */}
                {commonToken &&
                    <div className={styles.commonToken}>
                        <h6>{tokenTitle}</h6>
                        <div className={styles.commonTokenList}>
                            {commonToken.map(item =>
                                <Form.Group key={item.tokenId} className={styles.formGroup}>
                                    <Form.Control type="radio" id="{item.tokenId}" name="commonToken" onClick={() => handleClick(item.tokenImg, item.tokenTitle)}/>
                                    <Form.Label><Image src={item.tokenImg} />{item.tokenTitle}</Form.Label>
                                </Form.Group>
                            )}
                        </div>
                    </div>
                }
                <ul className={styles.tokens}>
                    {tokens.map(item => 
                        <li key={item.Id}>
                            <Button type='button' onClick={() => handleClick(item.img, item.name)}>
                                <p><Image src={item.img} /> {item.name}</p>
                                <span>{item.totalToken} {item.shortName} <AiOutlinePaperClip /></span>
                            </Button>
                        </li>
                    )}
                </ul>
                <Link to="/" className={styles.learnMoreBtn}>Learn More <HiOutlineExternalLink /></Link>
            </Form>
        </div>
    )
}

export default Index