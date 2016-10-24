import React, {PropTypes} from 'react';
import appTheme from 'universal/styles/theme/appTheme';

const Button = (props) => {
  const cellStyle = {
    backgroundColor: `${props.backgroundColor}`,
    color: '#FFFFFF',
    fontWeight: 'bold',
    textAlign: 'center',
    textTransform: 'uppercase'
  };

  const linkStyle = {
    backgroundColor: `${props.backgroundColor}`,
    color: '#FFFFFF',
    display: 'block',
    fontWeight: 'bold',
    paddingBottom: `${props.vPadding}px`,
    paddingTop: `${props.vPadding}px`,
    textDecoration: 'none',
    textTransform: 'uppercase',
    width: '100%'
  };

  return (
    <table width={`${props.width}px`}>
      <tbody>
        <tr>
          <td style={cellStyle}>
            <a href={props.url} style={linkStyle}>
              {props.children}
            </a>
          </td>
        </tr>
      </tbody>
    </table>
  );
};

Button.defaultProps = {
  backgroundColor: appTheme.palette.cool,
  vPadding: 12,
  width: 240
};

Button.propTypes = {
  backgroundColor: PropTypes.string,
  children: PropTypes.any,
  vPadding: PropTypes.number,
  url: PropTypes.string,
  width: PropTypes.number
};

export default Button;
