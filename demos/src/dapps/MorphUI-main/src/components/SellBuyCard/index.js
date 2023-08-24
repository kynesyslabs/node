import React, {useState} from 'react'
import { Image, Button } from 'react-bootstrap';
import styles from "./sellBuyCard.module.css";
import SettingsIcon from '../../assets/images/settings-icon.svg';
import TransactionPopup from '../../components/TransactionPopup';
import { RxChevronDown } from 'react-icons/rx';

const Index = ({headingLabel, heading, headingIcon, settings, cardHeading, cardTotal, cardDescription, modalPopup, setModalPopup, setCheckClicked, clickedDropdown}) => {

    const [openModal, setOpenModal] = useState(false);

    const handleClicked = () => {
        setModalPopup(!modalPopup);
        setCheckClicked(clickedDropdown);
    }

    return (
        <div className={styles.sellBuyWrap}>
            <div className={styles.sellBuyHeading}>
                <div className={styles.dropdownBtnWrap}>
                    {headingLabel && <span>{headingLabel}</span>}
                    <Button className={styles.dropdownBtn} onClick={handleClicked}>
                        <Image src={headingIcon} />
                        {heading}
                        <RxChevronDown />
                    </Button>
                </div>
                {settings &&
                    <div className={styles.settingWrap}>
                        <Button type="button" className={styles.settingBtn} onClick={() => setOpenModal(!openModal)}><Image src={SettingsIcon} /></Button>
                        {openModal && <TransactionPopup openModal={openModal} setOpenModal={setOpenModal} />}
                    </div>
                }
            </div>
            <div className={styles.sellBuyCard}>
                <div className={styles.sellBuyInnerHeading}>
                    <h4>{cardHeading}</h4><h3>{cardTotal}</h3>
                </div>
                <ul>
                    {cardDescription.map((item, index) => 
                        <li key={index}>
                            <p>{item.title}</p>
                            <p>{item.subtotal} {item.negativePercentage && <span>&#40;{item.negativePercentage}&#41;</span>}</p>
                        </li>
                    )}
                </ul>
            </div>
        </div>
    )
}

export default Index