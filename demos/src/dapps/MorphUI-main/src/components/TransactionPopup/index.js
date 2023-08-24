import React from 'react'
import { Button, Form } from 'react-bootstrap';
import styles from './transactionPopup.module.css';
import { IoClose } from 'react-icons/io5';
import { MdOutlineInfo } from 'react-icons/md';

const transactions = [{
    label : "Default"
  },{
    label : "Standard"
  },{
    label : "Fast"
  },{
    label : "Instant"
  }
]

const tolerance = [{
    label : 0.1
  },{
    label : 0.5
  },{
    label : 1.0
  }
]

const Index = ({openModal, setOpenModal}) => {
  return (
    <div className={styles.settingModal}>
      <div className={styles.settingHeading}>
          <h6>Transaction settings</h6>
          <Button className={styles.closeBtn} onClick={() => setOpenModal(!openModal)}>
              <IoClose />
          </Button>
      </div>
      <Form className={styles.transactionForm}>
          <Form.Group className={styles.formGroup}>
              <Form.Label>Transaction Speed (GWEI) <MdOutlineInfo /></Form.Label>
              <div className={styles.checkboxWrap}>
                {transactions.map((item, index) =>
                    <Form.Check key={index} className={styles.formCheck}>
                        <Form.Control type="radio" id={index} name="transactionSpeed"/>
                        <Form.Label>{item.label}</Form.Label>
                    </Form.Check>
                )}
              </div>
          </Form.Group>
          <Form.Group className={styles.formGroup}>
              <Form.Label>Slippage Tolerance <MdOutlineInfo /></Form.Label>
              <div className={styles.checkboxWrap}>
                {tolerance.map((item, index) =>
                    <Form.Check key={index} className={styles.formCheck}>
                        <Form.Control type="radio" id={index} name="tolerance" />
                        <Form.Label>{item.label}%</Form.Label>
                    </Form.Check>
                )}
                
                <span><Form.Control type="text" value="0.50" readOnly/> %</span>
              </div>
          </Form.Group>
          <Form.Group className={styles.txDeadline}>
              <Form.Label>Tx deadline (mins) <MdOutlineInfo /></Form.Label>
              <Form.Control type="text" value="20" readOnly/>
          </Form.Group>
      </Form>
  </div>
  )
}

export default Index